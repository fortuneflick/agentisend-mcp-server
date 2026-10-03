/**
 * M5.28 — the local stdio server.
 *
 * Plenty of MCP clients still only speak stdio: they launch a command and talk
 * to it over pipes. AgentiSend's server is HTTP, so those clients could not
 * reach it at all — which for a product whose whole pitch is "agents are
 * first-class" is the wrong door to leave locked.
 *
 * It is a PROXY, deliberately, not a second implementation. Every tool,
 * resource and prompt is forwarded to the hosted server with the caller's own
 * API key, so the local surface is the hosted surface by construction rather
 * than by discipline: there is no catalogue here to drift, no gate to
 * re-enforce, and no budget kept in two places. The one thing this process
 * adds is the transport.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export const SERVER_NAME = 'agentisend-local';
export const SERVER_VERSION = '0.1.2';

export interface ProxyOptions {
  /** Where the hosted MCP endpoint lives, e.g. https://api.agentisend.com/mcp */
  url: string;
  /** The caller's own credential. Never logged, never echoed back. */
  apiKey: string;
  /** Injectable so tests can drive the pair without spawning a process. */
  clientTransportFactory?: (url: URL, apiKey: string) => Transport;
}

/** One upstream connection, reused for every forwarded call until the hosted server ends it. */
export async function connectUpstream(options: ProxyOptions): Promise<Client> {
  const client = new Client(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: {} },
  );
  const url = new URL(options.url);
  const transport =
    options.clientTransportFactory?.(url, options.apiKey) ??
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${options.apiKey}` } },
    });
  await client.connect(transport);
  return client;
}

/**
 * DX-4: the upstream said this connection is gone. Sessions live in the API
 * process, so a deploy or 30 idle minutes ends them, and the API answers 404
 * (session_expired / session_not_found). A request refused that way ran
 * nothing, so it is safe to open a fresh connection and send it again.
 */
function sessionGone(err: unknown): boolean {
  return err instanceof StreamableHTTPError && err.code === 404;
}

/**
 * The API was not listening (a restart window). The request never left this
 * machine, so replaying it cannot run anything twice. Any other network
 * failure might have reached the server, so it is not replayed.
 */
function neverSent(err: unknown): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    if ((cause as { code?: unknown }).code === 'ECONNREFUSED') return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A server that answers every request by asking the hosted one.
 *
 * Errors are forwarded as they arrive rather than being reshaped: the whole
 * value of the hosted error catalogue is its `fix` field, and a proxy that
 * rewrote refusals into its own words would throw that away at exactly the
 * moment the agent needs it.
 *
 * DX-4: it says what the hosted server says at initialize (its
 * `instructions`), passes on `notifications/tools/list_changed`, and, given
 * the options it connected with, opens a fresh upstream connection when the
 * hosted one is gone instead of failing every call until the host restarts.
 */
export function createProxyServer(first: Client, options?: ProxyOptions): Server {
  let upstream = first;
  let reconnecting: Promise<Client> | null = null;
  /**
   * `list_more_tools` calls that added tools to the upstream session's list.
   * A fresh session starts at the default list, so they are replayed on it.
   */
  const moreToolsCalls = new Map<string, Record<string, unknown>>();

  const instructions = first.getInstructions();
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      ...(instructions !== undefined ? { instructions } : {}),
    },
  );

  const forwardListChanges = (client: Client): void => {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await server.sendToolListChanged();
    });
  };
  forwardListChanges(first);

  /**
   * Calls still waiting on each connection. A replaced connection is closed
   * only once none are: closing it earlier would cut off a call that may
   * already have run, and that call must not be replayed.
   */
  const inFlight = new Map<Client, number>();
  const retireIfIdle = (client: Client): void => {
    if (client === upstream || (inFlight.get(client) ?? 0) > 0) return;
    inFlight.delete(client);
    void client.close().catch(() => undefined);
  };

  /** One reconnect for every call that met the same dead connection. */
  function reconnect(stale: Client, connectOptions: ProxyOptions): Promise<Client> {
    if (upstream !== stale) return Promise.resolve(upstream);
    reconnecting ??= (async () => {
      try {
        const fresh = await connectUpstream(connectOptions);
        forwardListChanges(fresh);
        try {
          for (const args of moreToolsCalls.values()) {
            await fresh.callTool({ name: 'list_more_tools', arguments: args });
          }
        } catch (err) {
          // Not adopted, so nothing else would ever close it.
          void fresh.close().catch(() => undefined);
          throw err;
        }
        upstream = fresh;
        retireIfIdle(stale);
        return fresh;
      } finally {
        reconnecting = null;
      }
    })();
    return reconnecting;
  }

  async function on<T>(client: Client, call: (client: Client) => Promise<T>): Promise<T> {
    inFlight.set(client, (inFlight.get(client) ?? 0) + 1);
    try {
      return await call(client);
    } finally {
      inFlight.set(client, (inFlight.get(client) ?? 1) - 1);
      retireIfIdle(client);
    }
  }

  async function withUpstream<T>(call: (client: Client) => Promise<T>): Promise<T> {
    const client = reconnecting !== null ? await reconnecting : upstream;
    try {
      return await on(client, call);
    } catch (err) {
      if (!options || !(sessionGone(err) || neverSent(err))) throw err;
      return on(await reconnect(client, options), call);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    withUpstream((client) => client.listTools()),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await withUpstream((client) =>
      client.callTool({ name: request.params.name, arguments: args }),
    );
    if (request.params.name === 'list_more_tools' && result.isError !== true) {
      moreToolsCalls.set(JSON.stringify(args), args);
    }
    return result;
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () =>
    withUpstream((client) => client.listResources()),
  );
  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    withUpstream((client) => client.readResource({ uri: request.params.uri })),
  );
  server.setRequestHandler(ListPromptsRequestSchema, async () =>
    withUpstream((client) => client.listPrompts()),
  );
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    withUpstream((client) =>
      client.getPrompt({
        name: request.params.name,
        ...(request.params.arguments !== undefined ? { arguments: request.params.arguments } : {}),
      }),
    ),
  );

  return server;
}

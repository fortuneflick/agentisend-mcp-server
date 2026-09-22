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
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
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

/** The upstream connection, opened once and reused for every forwarded call. */
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
 * A server that answers every request by asking the hosted one.
 *
 * Errors are forwarded as they arrive rather than being reshaped: the whole
 * value of the hosted error catalogue is its `fix` field, and a proxy that
 * rewrote refusals into its own words would throw that away at exactly the
 * moment the agent needs it.
 */
export function createProxyServer(upstream: Client): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => await upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstream.callTool({
      name: request.params.name,
      arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
    }),
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => await upstream.listResources());
  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    upstream.readResource({ uri: request.params.uri }),
  );
  server.setRequestHandler(ListPromptsRequestSchema, async () => await upstream.listPrompts());
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    upstream.getPrompt({
      name: request.params.name,
      ...(request.params.arguments !== undefined ? { arguments: request.params.arguments } : {}),
    }),
  );

  return server;
}

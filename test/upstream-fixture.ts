/**
 * A stand-in for the hosted /mcp endpoint, on a real port, speaking real
 * Streamable HTTP — so the proxy under test uses the same client transport
 * it uses against the API.
 *
 * Like the API: one server+transport pair per session, JSON responses, and
 * an unknown session id answered 404 with the session_expired refusal.
 * `restart()` drops every session the way a deploy does; `stop()`/`start()`
 * take the port away and give it back.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export const UPSTREAM_INSTRUCTIONS =
  'Call whoami once, first. A refusal with retryable: false means waiting cannot help; do not loop.';

export interface Upstream {
  url: string;
  /** How many sessions were opened, across restarts. */
  initializes(): number;
  /** Drop every session, as a deploy does. The port stays up. */
  restart(): Promise<void>;
  /** Take the port away. */
  stop(): Promise<void>;
  /** Listen again on the same port. */
  start(): Promise<void>;
  close(): Promise<void>;
}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'upstream-fixture', version: '1' },
    { instructions: UPSTREAM_INSTRUCTIONS, debouncedNotificationMethods: ['notifications/tools/list_changed'] },
  );
  server.registerTool('ping', { description: 'Answers pong.' }, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  const extra: RegisteredTool = server.registerTool(
    'create_template',
    { description: 'Listed only after list_more_tools.' },
    async () => ({ content: [{ type: 'text' as const, text: 'created' }] }),
  );
  extra.disable();
  server.registerTool('list_more_tools', { description: 'Adds the rest to tools/list.' }, async () => {
    if (!extra.enabled) extra.enable();
    return {
      content: [{ type: 'text' as const, text: '{"data":[{"name":"create_template"}]}' }],
      structuredContent: { data: [{ name: 'create_template' }] },
    };
  });
  return server;
}

export async function startUpstream(): Promise<Upstream> {
  let sessions = new Map<string, StreamableHTTPServerTransport>();
  let opened = 0;

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text.length > 0 ? JSON.parse(text) : undefined;
  }

  function expired(res: ServerResponse): void {
    res.writeHead(404, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32004,
          message: 'This connection to AgentiSend has expired. Reconnect your AI client.',
          data: { reason: 'session_expired', retryable: false },
        },
      }),
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const header = req.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;
    if (sessionId !== undefined) {
      const transport = sessions.get(sessionId);
      if (!transport) return expired(res);
      return transport.handleRequest(req, res, body);
    }
    const isInitialize = (body as { method?: unknown } | undefined)?.method === 'initialize';
    if (!isInitialize) return expired(res);
    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
    });
    sessions.set(id, transport);
    opened += 1;
    await buildServer().connect(transport);
    return transport.handleRequest(req, res, body);
  }

  let http: HttpServer | undefined;
  let port = 0;
  async function start(): Promise<void> {
    http = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500).end(String(err));
      });
    });
    await new Promise<void>((resolve) => http!.listen(port, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  }
  async function dropSessions(): Promise<void> {
    const old = sessions;
    sessions = new Map();
    for (const transport of old.values()) await transport.close().catch(() => undefined);
  }
  async function stop(): Promise<void> {
    await dropSessions();
    const server = http;
    http = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await start();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    initializes: () => opened,
    restart: dropSessions,
    stop,
    start,
    close: stop,
  };
}

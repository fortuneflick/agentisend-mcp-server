import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectUpstream, createProxyServer } from '../src/proxy.js';
import { startUpstream, type Upstream } from './upstream-fixture.js';

/**
 * DX-4 — a deploy does not break the stdio server until the host restarts.
 *
 * Hosted sessions live in the API process. A deploy (every push to main) or
 * 30 idle minutes drops them, and the upstream answers 404 session_expired to
 * the id the proxy holds. The proxy opened one upstream connection and never
 * opened another, so every call failed until the person restarted Claude
 * Desktop. It now opens a fresh connection once and replays the call; a call
 * refused for an unknown session ran nothing, so replaying it is safe.
 */
describe('stdio proxy: survives an API restart', () => {
  let upstream: Upstream | undefined;
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await upstream?.close();
  });

  async function proxied(): Promise<Client> {
    upstream = await startUpstream();
    const options = { url: upstream.url, apiKey: 'as_test_key' };
    const server = createProxyServer(await connectUpstream(options), options);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'host', version: '1' }, { capabilities: {} });
    await client.connect(clientSide);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  const text = (result: unknown): string =>
    ((result as { content: Array<{ text: string }> }).content[0] ?? { text: '' }).text;

  it('reconnects once and replays the call when the upstream session is gone', async () => {
    const client = await proxied();
    expect(text(await client.callTool({ name: 'ping', arguments: {} }))).toBe('pong');
    expect(upstream!.initializes()).toBe(1);

    await upstream!.restart();

    expect(text(await client.callTool({ name: 'ping', arguments: {} }))).toBe('pong');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('ping');
    expect(upstream!.initializes(), 'one new session, not one per call').toBe(2);
  });

  it('shares one reconnect between calls that fail together', async () => {
    const client = await proxied();
    await upstream!.restart();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.callTool({ name: 'ping', arguments: {} })),
    );
    expect(results.map(text)).toEqual(['pong', 'pong', 'pong', 'pong', 'pong']);
    expect(upstream!.initializes()).toBe(2);
  });

  it('keeps the tools list_more_tools added across the reconnect', async () => {
    const client = await proxied();
    await client.callTool({ name: 'list_more_tools', arguments: {} });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('create_template');

    await upstream!.restart();

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('create_template');
    expect(text(await client.callTool({ name: 'create_template', arguments: {} }))).toBe('created');
  });

  it('works again once the API is back after being down', async () => {
    const client = await proxied();
    await upstream!.stop();
    await expect(client.callTool({ name: 'ping', arguments: {} })).rejects.toThrow();
    await upstream!.start();
    expect(text(await client.callTool({ name: 'ping', arguments: {} }))).toBe('pong');
  });
});

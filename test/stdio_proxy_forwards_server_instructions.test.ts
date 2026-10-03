import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectUpstream, createProxyServer } from '../src/proxy.js';
import { startUpstream, UPSTREAM_INSTRUCTIONS, type Upstream } from './upstream-fixture.js';

/**
 * DX-4 — the stdio server says what the hosted server says.
 *
 * The hosted server's `instructions` (whoami first, do not loop on a
 * non-retryable refusal) reach a client at initialize. The stdio proxy built
 * its own server with none, so Claude Desktop and Windsurf users never got
 * them. It also dropped `notifications/tools/list_changed`, so a tool
 * `list_more_tools` added upstream never reached the host's list.
 */
describe('stdio proxy: forwards the server instructions and list changes', () => {
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

  it('hands the host the upstream instructions at initialize', async () => {
    const client = await proxied();
    expect(client.getInstructions()).toBe(UPSTREAM_INSTRUCTIONS);
  });

  it('tells the host when the upstream tool list changes', async () => {
    const client = await proxied();
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    const before = (await client.listTools()).tools.map((tool) => tool.name);
    expect(before).not.toContain('create_template');

    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no notifications/tools/list_changed within 5 s')), 5_000);
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await client.callTool({ name: 'list_more_tools', arguments: {} });
    await changed;
    const after = (await client.listTools()).tools.map((tool) => tool.name);
    expect(after).toContain('create_template');
  });
});

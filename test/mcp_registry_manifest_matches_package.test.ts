import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_URL } from '../src/cli.js';

/**
 * The official MCP registry listing (docs/DISTRIBUTION.md §1).
 *
 * `server.json` is the document the registry publisher reads. Nothing in it is
 * a second copy of a fact that already exists: the name, version and
 * description are the npm package's, the stdio launcher's environment
 * variables are the ones `cli.ts` actually reads, and the remote endpoint is
 * the one every other surface names. A registry entry that points at a dead
 * URL or advertises an env var the binary ignores is worse than no entry —
 * the client fails after the user has already trusted the listing.
 *
 * Validated against the published schema
 * (https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
 * when it was written; this pin holds the values, not the shape.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const manifest = JSON.parse(
  readFileSync(resolve(here, '../server.json'), 'utf8'),
) as {
  $schema: string;
  name: string;
  description: string;
  version: string;
  repository: { url: string; source: string; subfolder?: string };
  packages: {
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    environmentVariables: { name: string; isRequired: boolean; isSecret: boolean }[];
  }[];
  remotes: { type: string; url: string; headers: { name: string; isRequired: boolean }[] }[];
};

const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
  name: string;
  version: string;
  description: string;
  bin: Record<string, string>;
};

const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

describe('mcp_registry_manifest_matches_package', () => {
  it('names the schema version it was written against', () => {
    expect(manifest.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/,
    );
  });

  it('the server name is reverse-DNS with exactly one slash, as the schema requires', () => {
    expect(manifest.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    // Published name on registry.modelcontextprotocol.io (docs/DISTRIBUTION.md).
    // com.agentisend/mcp-server needs a DNS TXT proof that is not in place.
    expect(manifest.name).toBe('io.github.fortuneflick/agentisend');
  });

  it('description and version are the npm package, not a retyped copy', () => {
    expect(manifest.description).toBe(pkg.description);
    expect(manifest.version).toBe(pkg.version);
  });

  it('the npm package block points at the package this directory publishes', () => {
    const npm = manifest.packages.find((entry) => entry.registryType === 'npm');
    expect(npm, 'the stdio launcher is listed').toBeTruthy();
    expect(npm!.identifier).toBe(pkg.name);
    expect(npm!.version).toBe(pkg.version);
    expect(npm!.transport.type).toBe('stdio');
    expect(Object.keys(pkg.bin).length, 'and it is runnable via npx').toBeGreaterThan(0);
  });

  it('every environment variable it advertises is one the launcher reads', () => {
    const cli = read('packages/mcp-server/src/cli.ts');
    const npm = manifest.packages.find((entry) => entry.registryType === 'npm')!;
    for (const variable of npm.environmentVariables) {
      expect(cli, `${variable.name} is read by cli.ts`).toContain(variable.name);
    }
    const key = npm.environmentVariables.find((v) => v.name === 'AGENTISEND_API_KEY')!;
    expect(key.isRequired).toBe(true);
    // A credential marked public is a credential a client may log.
    expect(key.isSecret).toBe(true);
  });

  it('the remote endpoint is the one every other surface names', () => {
    const remote = manifest.remotes.find((entry) => entry.type === 'streamable-http');
    expect(remote, 'the hosted server is listed too').toBeTruthy();
    expect(remote!.url).toBe(DEFAULT_URL);
    // The landing's /.well-known/mcp.json, the console's client snippets and
    // the Claude Code plugin all state this URL. They may not disagree.
    expect(read('apps/landing/src/seo/to-markdown.ts')).toContain(
      `export const API_ORIGIN = '${new URL(DEFAULT_URL).origin}'`,
    );
    expect(read('apps/console/src/components/mcp/mcp-snippets.ts')).toContain(
      `export const MCP_SERVER_URL = '${DEFAULT_URL}'`,
    );
    expect(read('plugins/agentisend/.mcp.json')).toContain(DEFAULT_URL);
    const auth = remote!.headers.find((header) => header.name === 'Authorization');
    expect(auth?.isRequired).toBe(true);
  });

  it('the repository is the one this file lives in, so the code can be read', () => {
    expect(manifest.repository.source).toBe('github');
    expect(manifest.repository.url).toMatch(/^https:\/\/github\.com\//);
    expect(manifest.repository.subfolder).toBe('packages/mcp-server');
  });
});

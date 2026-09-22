#!/usr/bin/env node
/**
 * The launcher an MCP client runs: `npx -y @agentisend/mcp-server`.
 *
 * Everything it needs comes from the environment, because that is what MCP
 * client configs can set. Nothing is read from a file and no credential is
 * ever accepted as an argument — process arguments are visible to every other
 * process on the machine.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectUpstream, createProxyServer, SERVER_VERSION } from './proxy.js';

export const DEFAULT_URL = 'https://api.agentisend.com/mcp';

const USAGE = `agentisend-mcp — AgentiSend's MCP server, over stdio.

Run it from an MCP client config; it speaks on stdin/stdout and logs to stderr.

Environment:
  AGENTISEND_API_KEY   Required. Your API key (as_…).
  AGENTISEND_MCP_URL   Optional. Defaults to ${DEFAULT_URL}.

Example client config:
  {
    "mcpServers": {
      "agentisend": {
        "command": "npx",
        "args": ["-y", "@agentisend/mcp-server"],
        "env": { "AGENTISEND_API_KEY": "as_…" }
      }
    }
  }

Every tool, resource and prompt comes from the hosted server, so what you get
here is exactly what an HTTP client gets — including the budget and the stops.`;

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }

  const apiKey = env['AGENTISEND_API_KEY'];
  if (!apiKey) {
    // stderr, not stdout: stdout is the protocol channel and a stray line on
    // it is a parse error in the client rather than a message anyone reads.
    process.stderr.write(
      'AGENTISEND_API_KEY is not set, so there is nothing to authenticate with. ' +
        'Set it in your MCP client config (env), then start the client again. ' +
        'Run with --help for an example.\n',
    );
    return 1;
  }

  const url = env['AGENTISEND_MCP_URL'] ?? DEFAULT_URL;
  try {
    const upstream = await connectUpstream({ url, apiKey });
    const server = createProxyServer(upstream);
    await server.connect(new StdioServerTransport());
    process.stderr.write(`agentisend-mcp connected to ${url}\n`);
    return 0;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Could not reach the AgentiSend MCP server at ${url}: ${detail}\n` +
        'Check AGENTISEND_MCP_URL and that the key is valid, then start the client again.\n',
    );
    return 1;
  }
}

/**
 * True only when this file is the process entrypoint. `import.meta.url` alone
 * is not enough — anything that imports this module for its exports would run
 * the command as a side effect of the import — and a plain path comparison is
 * not enough either: an installed `bin` is a symlink, so argv[1] is the link
 * and the module URL is its target. Both sides are resolved through the real
 * path before they are compared.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const real = (path: string): string => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    };
    return real(entry) === real(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = await main();
  // A successful start keeps the process alive on the stdio transport; only a
  // failure or a one-shot flag exits here.
  if (code !== 0 || process.argv.slice(2).some((arg) => arg.startsWith('-'))) {
    process.exit(code);
  }
}

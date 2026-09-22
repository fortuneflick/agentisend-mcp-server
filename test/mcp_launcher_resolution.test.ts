import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * M5.28 — the launcher artifact gate.
 *
 * A local MCP server that works in the repository and fails from a tarball is
 * a support ticket per user, and the ways it fails are all invisible in
 * review: a `bin` pointing at a file `files` does not ship, a missing
 * shebang, a dependency that was only ever present because the workspace had
 * it. None of that shows up in a unit test — the only thing that catches it is
 * building the artifact the way a user gets it and running THAT.
 *
 * So this packs the package, installs the tarball into a throwaway directory
 * with its own npm cache, and executes the installed binary. It needs the
 * registry the first time (the cache is warm afterwards), which is the honest
 * cost of testing an install.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
/** Shared between runs on purpose: an install gate should not be slow twice. */
const npmCache = join(tmpdir(), 'agentisend-launcher-gate-cache');

describe('mcp_launcher_resolution: the published artifact runs from outside the repo', () => {
  let workDir: string;
  let installed: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agentisend-launcher-'));

    // 1. Pack exactly what would be published.
    execFileSync('pnpm', ['pack', '--pack-destination', workDir], {
      cwd: packageDir,
      stdio: 'pipe',
    });
    const version = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      version: string;
    }).version;
    const tarball = join(workDir, `agentisend-mcp-server-${version}.tgz`);
    expect(existsSync(tarball), 'the tarball was produced').toBe(true);

    // 2. Install it somewhere that knows nothing about this workspace.
    const app = join(workDir, 'app');
    execFileSync('npm', ['init', '-y'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('mkdir', ['-p', app]);
    execFileSync('npm', ['init', '-y'], { cwd: app, stdio: 'pipe' });
    execFileSync(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        '--cache',
        npmCache,
        tarball,
      ],
      { cwd: app, stdio: 'pipe' },
    );
    installed = join(app, 'node_modules', '.bin', 'agentisend-mcp');
  }, 300_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('the bin the package declares is present after a real install', () => {
    expect(existsSync(installed), 'npm linked the binary the package declares').toBe(true);
  });

  it('the installed launcher executes and reports its version', () => {
    const out = execFileSync(installed, ['--version'], { encoding: 'utf8' });
    const version = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      version: string;
    }).version;
    expect(out.trim()).toBe(version);
  });

  it('--help explains how to configure it, without needing a key', () => {
    const out = execFileSync(installed, ['--help'], { encoding: 'utf8' });
    expect(out).toContain('AGENTISEND_API_KEY');
    expect(out, 'it shows a config an MCP client can paste').toContain('mcpServers');
  });

  it('without a key it fails loudly on stderr and leaves stdout clean', () => {
    const result = spawnSync(installed, [], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });
    expect(result.status, 'a missing credential is a failure, not a silent no-op').toBe(1);
    expect(result.stderr).toContain('AGENTISEND_API_KEY');
    expect(
      result.stdout,
      'stdout is the protocol channel — a stray line there is a parse error in the client',
    ).toBe('');
  });

  it('an unreachable server is reported in words, not a stack trace', () => {
    const result = spawnSync(installed, [], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        AGENTISEND_API_KEY: 'as_not_a_real_key',
        // Nothing listens here; the connection must fail fast and explain.
        AGENTISEND_MCP_URL: 'http://127.0.0.1:1/mcp',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('127.0.0.1:1');
    expect(result.stderr, 'it says what to check').toMatch(/AGENTISEND_MCP_URL/);
    expect(result.stdout).toBe('');
  });

  it('publishing cannot ship a stale build', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      files: string[];
      bin: Record<string, string>;
    };
    expect(manifest.scripts['prepublishOnly'], 'the build runs before a publish').toContain('build');
    // The bin must live under something `files` actually ships.
    const binTarget = Object.values(manifest.bin)[0]!;
    expect(manifest.files.some((entry) => binTarget.startsWith(entry))).toBe(true);
  });
});

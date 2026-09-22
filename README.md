# AgentiSend — MCP server (stdio launcher)

AgentiSend is a transactional email API for AI agents and the products they run inside: verify a domain, create a key with a budget, send over REST or MCP, and read a log that says what happened to every message.

This package is the stdio launcher for clients that start a command and talk over pipes rather than speaking HTTP MCP. It is a proxy, not a second implementation: every tool, resource and prompt is forwarded to the hosted server at `https://api.agentisend.com/mcp` with your key, so what you get here is exactly what an HTTP client gets — the same catalogue, the same budgets, the same stops, and refusals with their `fix` field intact.

## Install

```bash
npm install -g @agentisend/mcp-server
```

Most clients do not need that: `npx -y @agentisend/mcp-server` fetches it on first launch.

## Add it to your MCP client

```json
{
  "mcpServers": {
    "agentisend": {
      "command": "npx",
      "args": ["-y", "@agentisend/mcp-server"],
      "env": { "AGENTISEND_API_KEY": "your-key" }
    }
  }
}
```

| Variable | Required | Meaning |
|---|---|---|
| `AGENTISEND_API_KEY` | yes | Your API key. Read from the environment only — never passed as an argument, because process arguments are visible to every other process on the machine. |
| `AGENTISEND_MCP_URL` | no | The hosted endpoint this launcher proxies to. Defaults to `https://api.agentisend.com/mcp`. |

`--help` prints the config above. `--version` prints the version. Both work without a key.

## Send

Once connected, this is one turn:

> Send a receipt to customer@example.com from receipts@yourdomain.com.

The agent calls `send_email`. `preflight_email` runs every gate a real send runs, sends nothing and costs nothing. Every 4xx returns `code`, `message` and `fix`. There is no tool for unsolicited mail.

## Connecting over HTTP instead

Point any HTTP MCP client at `https://api.agentisend.com/mcp`. Auth is a bearer API key or OAuth 2.1 with dynamic client registration — no launcher, no install.

## Links

- Docs: <https://agentisend.com/docs> · MCP guide: <https://agentisend.com/docs/guides/mcp>
- API contract: <https://agentisend.com/openapi.json>
- MCP endpoint: `https://api.agentisend.com/mcp`
- [AGENTS.md](AGENTS.md) — the short version, for an agent doing this without a person.

`server.json` is the Model Context Protocol registry manifest; its `repository` field points at the monorepo the registry entry was claimed from, and is left as the registry has it.

Problems: hello@agentisend.com. Licensed MIT.

This repository is generated from the AgentiSend monorepo; open an issue rather than a pull request.

# AGENTS.md

Instructions for an AI agent sending email through AgentiSend's MCP server.

AgentiSend is a transactional email API for AI agents and the products they run inside: verify a domain, create a key with a budget, send over REST or MCP, and read a log that says what happened to every message.

## 1. Connect

Over HTTP, point your client at `https://api.agentisend.com/mcp` with `Authorization: Bearer <your API key>`, or use OAuth 2.1 with dynamic client registration — same tools, same ceilings.

Over stdio, add this to the client's MCP config:

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

The key is read from `AGENTISEND_API_KEY` in the environment. Never hard-code it, never print it, never pass it as a command-line argument — process arguments are readable by every other process on the machine. If no key is present, stop and ask the person for one; do not invent a value.

## 2. Find the tool

`tools/list` returns the everyday set. The rest of the catalogue is behind `list_more_tools`, so call that before concluding a capability is missing.

## 3. Check before you send

`preflight_email` takes the same arguments as a send, runs every gate a real send runs — domain verification, budget, loop guard, suppression list, content checks — and sends nothing. It costs nothing. Use it whenever you are unsure.

## 4. Send

`send_email` takes one message, or a batch of up to 500 items with per-item results. Pass an idempotency key derived from the thing being done, never from the clock: the same key with the same body replays the first response instead of sending twice.

## 5. Read the outcome

`get_email` returns one message's status and history: queued, sent, delivered, and what happened in between.

## 6. When you are refused

Every 4xx carries `code`, `message` and `fix`. Read `fix` — it names the call that repairs the problem. Do not retry a refusal that is not a rate limit or a server error: retrying anything else is a loop against the thing that just refused you.

Two codes worth knowing: `agent_budget_exceeded` means the key you hold has spent its budget, and `fix` names the call that raises it — ask the person, do not raise it yourself. `approval_required` means the send is queued for a person; nothing was delivered and nothing more is needed from you.

## 7. Limits you should not route around

Every key carries a send budget and a rate ceiling, and one request pauses every sender on the account. AgentiSend does not send unsolicited mail and has no tool for it. If a task asks you to mail people who did not ask to hear from the sender, stop and say so.

## Links

Docs <https://agentisend.com/docs> · MCP guide <https://agentisend.com/docs/guides/mcp> · contract <https://agentisend.com/openapi.json>

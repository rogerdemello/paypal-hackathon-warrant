# @warrant/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an agent look at Warrant's records. Two tools, both read-only:

| Tool | Input | Returns |
|---|---|---|
| `verify_warrant` | `cart_jti` | A verdict (`verified`, `signed_with_open_questions`, `not_verified` or `not_found`) with a fixed-text summary, the mandate and cart, each signature and its key's status, the facts, the merchant's checkout findings, the order, the transparency-log entry and any dispute. It is the data behind the public Verify page |
| `get_dispute_facts` | `dispute_id` | The claim, the facts F1-F13 with their evidence, the outcome the rules table chose and why, who is responsible, and the proposed action |

Neither tool can pay, refund, accept, contest or change anything, and neither takes a price, a payee, a URL or a document: the only input is an identifier of a record, validated before anything is sent. The server's address and console token come from the operator's environment.

```bash
claude mcp add warrant -- pnpm --silent --filter @warrant/mcp start
```

| Variable | Default | |
|---|---|---|
| `WARRANT_API_URL` | `http://localhost:8787` | The Warrant server |
| `WARRANT_CONSOLE_TOKEN` | none | Needed for `get_dispute_facts` when the server is not in judge mode |

`pnpm --filter @warrant/mcp test` runs the tools over the MCP protocol (in memory) against the real server routes with real scenario data behind them. It was also run over real stdio against a running server.

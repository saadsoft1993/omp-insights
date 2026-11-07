# @oh-my-pi/omp-stats

Local observability dashboard for AI usage statistics.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.omp/agent/sessions/`
- **SQLite aggregation**: Stats storage in `bun:sqlite`, with hourly rollups so any range queries in milliseconds
- **Live web dashboard**: Opens instantly, ingests sessions in the background (newest first) and streams progress and updates to the page
- **Incremental sync**: Only processes new/modified log entries; a watcher re-syncs transcripts as they are written

## Metrics Tracked

| Metric                  | Calculation                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| Tokens/s                | `output_tokens / (duration / 1000)`                                        |
| Cache Rate              | `cache_read / (input + cache_read) * 100`                                  |
| Cache Savings           | `(uncached prompt cost - actual prompt cost) / uncached prompt cost * 100` |
| Error Rate              | `count(stopReason=error) / total_calls * 100`                              |
| API-equivalent estimate | Sum of token usage priced with the matching public API rate card           |
| Avg Latency             | Mean of `duration`                                                         |
| TTFT                    | Mean of `ttft` (time to first token)                                       |

Subscription-backed models use matching public API prices when an exact public model exists; these values estimate API-equivalent usage rather than the user's bill. Subscription-only models without a public price are reported as N/A and excluded from dollar totals.

## Usage

### Via CLI

```bash
# Start dashboard server (default: http://localhost:3847)
omp stats

# Custom port
omp stats --port 8080

# Print summary to console
omp stats --summary

# Output as JSON (for scripting)
omp stats --json
```

### Programmatic

```typescript
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats";

// Sync session logs to database
const { processed, files } = await syncAllSessions();

// Get aggregated stats
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);
```

## API Endpoints

| Endpoint                       | Description                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `GET /api/stats`               | Overall stats with all breakdowns                                                  |
| `GET /api/stats/models`        | Per-model statistics                                                               |
| `GET /api/stats/folders`       | Per-folder/project statistics                                                      |
| `GET /api/stats/timeseries`    | Hourly time series data                                                            |
| `GET /api/stats/accounts`      | Per-account requests, status, quota readings and routing, plus unattributed totals |
| `GET /api/stats/accounts/flow` | Requests and tokens per account per time bucket                                    |
| `GET /api/events`              | Server-sent live status: sync progress, data version, rollup backlog               |
| `GET /api/status`              | Current live status (same shape as the events)                                     |
| `POST /api/sync`               | Start a background sync; progress arrives on `/api/events`                         |

## Data Storage

- **Session logs**: `~/.omp/agent/sessions/` (JSONL files)
- **Stats database**: `~/.omp/stats.db` (SQLite)

Synchronization fetches file metadata and saved cursors in bounded batches and overlaps transcript reads, including on macOS without worker threads. Statistics and cursors commit atomically; unchanged files are skipped, and interrupted batches are retried without double-counting usage.

Full reconciliation replays still scan every transcript. Unchanged transcripts retain their indexed rows while missing or stale records and unfinished links are repaired; modified transcripts are rebuilt. Parsing discards message bodies after extracting statistics rather than retaining entire decoded transcripts.

Range queries read `message_rollup` / `tool_rollup` / `session_rollup`, maintained from the raw tables: triggers mark touched hours and transcripts dirty (from any omp process), and the dashboard re-rolls them newest-first in short transactions. Reads stay exact by aggregating the few dirty hours raw; during an initial build the header shows the indexing backlog.

## Dashboard

Pages: Overview, Models, Providers, Accounts, Costs, Requests, Errors, Traces, Tools, Frustration, Projects and Gain. `1`–`6` pick the time range; `g` then a letter jumps to a page. Every page revalidates when the live data version moves, so there is no refresh button.

The Accounts page credits each request to the stored credential that served it (sessions record its `auth_credentials` id) and merges credentials with the same provider, email and organization into one account. A credential stored under a bare `account:<uuid>` identity is resolved to its email and organization through the usage history, and a numbered login slot of a provider (`anthropic-2`) joins the matching account of the base provider. Identity, disable state, rate-limit blocks and quota readings are read from the agent database without touching credential secrets. Each provider's request total for the range matches the Providers page and is shown as requests on accounts plus requests not tied to an account (background calls such as titles, memory and judges, environment API keys, gateways, older sessions).

omp keeps a session on one credential but can rotate it to another, and new sessions can start on a different account, so two accounts of one provider can serve traffic at the same time. The page's traffic split shows, per provider, the measured share of each account's requests over the last 15 minutes, which is the only reliable view of current routing. Below it, new-session lines show which account served the first request of recent main sessions (subagents follow their parent) and the last observed change of that account in the selected range; these are historical observations, since a rotation can move a session afterwards. The traffic chart stacks requests or tokens per account over the range. The Overview page carries a compact version of both.

## License

MIT

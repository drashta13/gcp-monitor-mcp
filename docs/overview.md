# About the project

## What it is

`gcp-monitor-mcp` is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets Claude read your Google Cloud estate: what you spend, what's running, how loaded it is, and whether it's healthy, across all your projects, from a conversation.

Instead of clicking through Billing, Cost Explorer, Monitoring, GKE, Cloud SQL, Compute and Logs Explorer in four projects, you ask:

> "Write this week's FinOps report and flag anything unusual."
> "Write a service health report for the last 7 days with root causes and follow-ups."

Claude calls the server's tools, gets compact JSON back, and writes the answer.

## Goals

- **One view across projects.** Every tool fans out over all allowed projects and merges the results.
- **Read-only.** No tool changes anything in Google Cloud. The identity it runs as has viewer roles only.
- **No secrets.** Auth is Application Default Credentials impersonating a read-only service account. No key files, no tokens in config.
- **Answers, not raw dumps.** Tools summarize: metrics become avg/max/latest, health checks become a plain-language `issues` list, costs are compared per day with anomalies flagged.
- **Works without billing admin.** Costs come from the App Optimize API (what Cost Explorer uses), which needs only project roles. The BigQuery billing export is supported when you have it.

## Reports it was built for

| Report | Tools |
|---|---|
| **Weekly FinOps report:** spend by service and resource, anomalies vs the previous weeks | `get_cost_comparison`, `get_top_cost_resources`, `get_cost_trend`, `get_resource_usage` |
| **Service health report:** incidents with root cause and follow-ups; GKE, Cloud SQL and VM health | `get_incidents`, `query_logs`, `get_gke_health`, `get_cloudsql_health`, `get_vm_health` |

## Architecture

```
┌──────────────────────────┐
│ Claude Desktop / Code    │  starts the server as a child process
└────────────┬─────────────┘
             │ MCP over stdio (JSON-RPC)
┌────────────▼─────────────┐
│ gcp-monitor-mcp (Node)   │  src/server.js: 25 tools, input validation (zod),
│                          │  background jobs + 10-min cache, error → hint
└────────────┬─────────────┘
             │ Application Default Credentials
             │ (your login, impersonating mcp-reader@home-project)
             ▼
   Google Cloud APIs, per project in the allowlist
   ├─ Resource Manager ......... list_projects
   ├─ Cloud Asset Inventory .... list_resources
   ├─ Cloud Monitoring ......... get_resource_usage, health metrics, alerts, uptime
   ├─ Cloud SQL Admin .......... get_cloudsql_health
   ├─ GKE ...................... get_gke_health
   ├─ Compute Engine ........... get_vm_health (VMs, disks, snapshots, schedules)
   ├─ OS Config (VM Manager) ... get_vm_health (OS, patches)
   ├─ Cloud Logging ............ query_logs, GKE events, autoscaler
   ├─ Service Health ........... get_incidents (Google outages)
   └─ App Optimize  or  BigQuery billing export ... cost tools
```

### Request flow

1. Claude calls a tool with JSON arguments. The SDK validates them against the tool's zod schema.
2. The project scope is resolved: the requested `projectIds`, checked against `GCP_MONITOR_ALLOWED_PROJECTS`, or all allowed projects.
3. The service module queries each project in parallel with a concurrency limit, collecting per-project failures instead of failing the whole call.
4. Results are merged, summarized and sorted (worst or most expensive first).
5. The server returns JSON text. Errors return as tool errors with a hint about the fix.

### Background jobs

Some Google Cloud calls are slow. An App Optimize cost report takes 15 to 60+ seconds; multi-project health checks and long log searches can also be slow. MCP clients give up after about 60 seconds. So slow tools are wrapped in `backgroundJob()`:

- The first call starts the work and waits up to 45 s.
- If it isn't done, the call returns `{ "status": "running" }` and the work continues.
- A repeat call with identical arguments attaches to the same run, or gets the finished result.
- Results are cached in memory for 10 minutes. Failures aren't cached.

### Design decisions

| Decision | Why |
|---|---|
| Plain JavaScript (ESM), official `@modelcontextprotocol/sdk`, `zod` | Small, no build step, matches the MCP reference servers |
| stdio transport | Runs locally under the user's own login; no server to host or secure |
| ADC + impersonation, no keys | Nothing secret on disk or in config; access is revocable centrally and audited |
| One service account for all projects | One identity to grant and revoke; roles per project |
| App Optimize as default cost source | The owner has no billing-admin access; it needs only project roles. Trade-off: list prices, about a year of history |
| One App Optimize report per project | The API accepts only one scope per report; the server fans out and merges |
| REST via `google-auth-library` for SQL, GKE, Compute, OS Config, Logging, Service Health | Avoids six heavy client libraries; responses are plain JSON |
| Client libraries for Asset Inventory, Monitoring, App Optimize, BigQuery | Pagination and streaming are worth it there |
| Server-side aggregation (`groupBy`, ~48 points) | Keeps Monitoring responses small and cheap |
| Health tools return an `issues` list | Claude and humans can act on findings without re-deriving thresholds |
| No custom resource-ID mapping | Tools work on plain GCP resource names; mapping to internal IDs is out of scope |

## Data sources and their limits

| Data | Source | Freshness | Limits |
|---|---|---|---|
| Costs (default) | App Optimize API (v1beta, preview) | lags up to 1 day | about the last year; list prices before credits/CUDs; Pacific days |
| Costs (optional) | Cloud Billing export in BigQuery | lags hours to 1 day | exact; history from when enabled |
| Inventory | Cloud Asset Inventory | minutes | |
| Metrics | Cloud Monitoring | ~1-3 min | VM memory/disk need the Ops Agent |
| Config / health | SQL Admin, GKE, Compute, OS Config APIs | live | OS/patch data needs VM Manager |
| Events / logs | Cloud Logging | seconds | log retention (30 days default); Data Access logs not readable |
| Incidents | Monitoring alerts, Service Health | live | only metrics with alert policies; availability only with uptime checks |

## Repository layout

```
gcp-monitor-mcp/
├── src/
│   ├── index.js            entry point: loads config, wires services, starts stdio transport
│   ├── server.js           tool definitions (schemas, descriptions), backgroundJob, error hints
│   ├── config.js           environment variables and validation
│   └── gcp/
│       ├── errors.js       ConfigError: a problem the caller can fix, shown to the model as-is
│       ├── util.js         project ID check + allowlist, perProject fan-out, concurrency limit, Map helpers
│       ├── rest.js         authenticated REST client (google-auth-library) with paging
│       ├── projects.js     list_projects
│       ├── inventory.js    list_resources (Cloud Asset Inventory)
│       ├── metrics.js      get_resource_usage: curated metric specs per kind
│       ├── appoptimize.js  cost tools via App Optimize
│       ├── billing.js      cost tools via BigQuery billing export
│       ├── comparison.js   week-vs-baseline comparison and anomaly rules
│       ├── sqlhealth.js    get_cloudsql_health
│       ├── gkehealth.js    get_gke_health
│       ├── vmhealth.js     get_vm_health
│       ├── incidents.js    get_incidents
│       └── logs.js         query_logs and its presets
├── test/                   node --test, offline with fake clients
└── docs/                   you are here
```

## Development

```bash
npm ci
npm test            # offline: fake Google clients, MCP over InMemoryTransport
npm run inspect     # MCP Inspector against your real projects
npm run coverage    # test coverage report
```

Code style is Prettier (`.prettierrc`: 120 columns, single quotes). CI (`.github/workflows/test.yml`) runs the tests on Node 22 and 24 (`node:sqlite` needs 22.13+).

- **Never write to stdout** (`console.log`). It is the MCP channel, and stray output corrupts the protocol. Log with `console.error`.
- New tools follow the same pattern: a service module in `src/gcp/` that takes `{ scope, rest | client, usage }`, uses `perProject()` for fan-out, and a `server.registerTool()` with a zod schema, `READ_ONLY` annotations and the `handler()` wrapper. Wrap slow ones with `job()`.
- Inject fakes in tests. No test touches Google Cloud.
- Keep tools read-only towards Google Cloud. A tool that writes to Google Cloud needs its own identity and a separate review (see [Security](security.md)). The history tools in `src/history/` write only to the local SQLite file.

## Status and roadmap

**v0.7.0:** 12 Google Cloud tools covering cost, inventory, usage and service health, plus 9 local history tools: day-aligned snapshots of everything, anomaly detection, and scheduled daily FinOps and Service Health reports. See [CHANGELOG.md](../CHANGELOG.md).

- [ ] Budgets and Recommender (idle resources, rightsizing suggestions)
- [ ] `get_cost_comparison` for the BigQuery export source
- [ ] Package as a Claude Desktop extension (`.mcpb`) for one-click install
- [ ] Optional HTTP transport for a shared, hosted deployment (needs its own auth design)

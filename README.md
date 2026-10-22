# gcp-monitor-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets Claude and other MCP clients monitor Google Cloud: what you spend, what's running, and how it's behaving, across all your projects, from a conversation.

> **Status: v0.7.0.** Cost (with week-over-baseline anomalies), inventory, usage metrics, service health (Cloud SQL, GKE, VMs, incidents, logs), and a local history database that a scheduled task fills with everything about each day, with anomaly detection and daily FinOps and Service Health reports.

## Tools

The server is **read-only towards Google Cloud**. Every Google Cloud tool is annotated `readOnlyHint`. The only two tools that write, `capture_snapshot` and `save_report`, write to a local SQLite file on your machine.

| Tool | Status | What it does |
|------|--------|--------------|
| `list_projects` | ✅ | Active projects this server can read (filtered by the allowlist, if set) |
| `get_cost_summary` | ✅ | Spend for a date range grouped by `service`, `project`, `sku` or `region` |
| `get_cost_trend` | ✅ | Net spend as daily, weekly or monthly points |
| `get_cost_comparison` | ✅ | This week vs the 3 weeks before, per day, by service and resource, with anomalies flagged (spikes, big increases, new and stopped spend). Built for a weekly FinOps report |
| `get_top_cost_resources` | ✅ | The individual resources that cost the most |
| `list_resources` | ✅ | Active resources across projects (VMs, GKE, Cloud SQL, Cloud Run, functions, Redis, buckets...) via Cloud Asset Inventory |
| `get_resource_usage` | ✅ | CPU, memory, pods, connections, requests... per resource from Cloud Monitoring, as avg / max / latest; also exact warning/error log volume (`kind: logs`) |
| `get_cloudsql_health` | ✅ | HA/failover, backups and PITR, backup runs, maintenance, plus uptime, CPU, memory, disk, connections, IOPS |
| `get_gke_health` | ✅ | Versions and skew, release channel, node pools and autoscaling, OOM / crash-loop / scheduling events, autoscaler decisions, restarts |
| `get_vm_health` | ✅ | OS and patch status (vulnerabilities), OS Config and Ops Agent health, snapshot coverage, CPU / memory / disk, unattached disks |
| `get_incidents` | ✅ | Alerting-policy incidents with duration, Google Cloud outages affecting you (Service Health), uptime-check availability |
| `query_logs` | ✅ | Cloud Logging search with presets (errors, k8s_warnings, oom, crashloop, changes, cloudsql, autoscaler) for root-cause evidence |
| `capture_snapshot` | ✅ | Everything about one day into the local history: cost by service / project / SKU / region / resource, cost anomalies, incidents and uptime, Cloud SQL / GKE / VM / Cloud Run health, GKE workloads, log volume and samples, inventory. Stored as raw results, metrics and findings, with anomalies vs the previous 14 days |
| `save_report` | ✅ | Save a written report and its conclusions to the history |
| `list_history`, `get_history` | ✅ | Browse saved reports and snapshots, including the raw tool results of any past day |
| `search_findings` | ✅ | Issue history: first seen, last seen, how many days, still open |
| `find_anomalies` | ✅ | Anything unusual on a day vs the days before: cost, utilization, errors, restarts, uptime |
| `add_event`, `list_events`, `delete_event` | ✅ | Sales calendar: planned scale-ups are expected, not anomalies |
| `review_event` | ✅ | A sale's cost vs normal and vs the previous sale, and anything not scaled back down after it |
| `get_metric_history` | ✅ | Daily cost and utilization series, as far back as the history goes |
| `diff_snapshots` | ✅ | What changed between two days: new, resolved and persisting issues, metrics that moved |
| `query_history_sql` | ✅ | Read-only SQL over the history for anything else |

Health, usage, incident and log tools accept `endTime` to look at a past window. Cost tools accept `startDate` / `endDate` (default month to date; days are UTC on the BigQuery export source and Pacific Time on the App Optimize source), `projectIds` and `service` filters.

## How it works

```
Claude Desktop / Claude Code
        │ stdio
        ▼
gcp-monitor-mcp (node) ── Application Default Credentials ──► mcp-reader service account
        │                                                      (read-only, impersonated)
        ├─► Resource Manager      list projects
        ├─► Cloud Asset Inventory list resources
        ├─► Cloud Monitoring      usage metrics, alerts, uptime checks
        ├─► Cloud SQL Admin, GKE, Compute, OS Config   health and configuration
        ├─► Cloud Logging         events and audit logs
        ├─► Service Health        Google Cloud incidents affecting you
        ├─► App Optimize API      cost reports (no billing access needed), or
        └─► BigQuery              Cloud Billing export (all projects on the billing account)
```

- **Costs come from one of two sources.** The App Optimize API (what Cost Explorer uses) needs no billing access but shows list prices, reaching back about a year. The Cloud Billing export to BigQuery is exact (credits and discounts applied) and keeps history. Both lag usage by up to a day.
- **Queries are parameterized** and the group-by/granularity options are whitelisted, so tool input never becomes SQL text. Each query filters on `_PARTITIONTIME` and is capped by `maximumBytesBilled`.
- **Errors come back as tool errors with a fix**, e.g. missing credentials suggests the `gcloud` command and permission errors name the role.
- **History is a local SQLite file** (`~/.gcp-monitor-mcp/history.db`, Node's built-in `node:sqlite`, no extra dependency), one snapshot per day. A Claude scheduled task captures each day, another writes the FinOps and Service Health reports from it, and any later chat can ask what changed, since when, and whether it's unusual. See [Scheduled tasks](docs/scheduled-tasks.md). `npm run capture` captures or backfills days from the terminal.

## Documentation

Full docs are in [`docs/`](docs/README.md):

- [About the project](docs/overview.md): architecture, design decisions, data sources and limits
- [Google Cloud setup](docs/gcp-setup.md): service account, roles per project, APIs, cost source
- [Local setup](docs/local-setup.md): install, log in, configure, run, troubleshoot
- [Connect it to Claude](docs/claude-setup.md): Claude Desktop and Claude Code, example prompts
- [Tools reference](docs/tools.md): every tool's inputs, outputs and how it works
- [Scheduled tasks](docs/scheduled-tasks.md): the daily capture and report tasks and their prompts
- [Security](docs/security.md): pitfalls to avoid

## Quick start

```bash
# 1. Google Cloud: a read-only service account you can impersonate (details: docs/gcp-setup.md)
gcloud iam service-accounts create mcp-reader --project=my-main-project
gcloud iam service-accounts add-iam-policy-binding mcp-reader@my-main-project.iam.gserviceaccount.com \
  --member="user:you@example.com" --role="roles/iam.serviceAccountTokenCreator"
# ...grant Viewer in each project, plus App Optimize Admin in my-main-project

# 2. Local
git clone https://github.com/drashta13/gcp-monitor-mcp.git && cd gcp-monitor-mcp
npm ci && npm test
gcloud auth application-default login \
  --impersonate-service-account=mcp-reader@my-main-project.iam.gserviceaccount.com
```

3. Add it to Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) and restart:

```json
{
  "mcpServers": {
    "gcp-monitor": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/gcp-monitor-mcp/src/index.js"],
      "env": {
        "GCP_COST_REPORT_PROJECT": "my-main-project",
        "GCP_MONITOR_ALLOWED_PROJECTS": "proj-a,proj-b"
      }
    }
  }
}
```

4. Ask Claude: "List my GCP projects."

| Variable | Purpose |
|----------|---------|
| `GCP_COST_REPORT_PROJECT` | Project that owns App Optimize cost reports (default cost source) |
| `GCP_MONITOR_ALLOWED_PROJECTS` | Comma-separated project allowlist (recommended) |
| `GCP_BILLING_EXPORT_TABLE` | BigQuery billing export table, used instead of App Optimize when set |
| `GCP_BILLING_QUERY_PROJECT` | Project that runs BigQuery jobs (default: the table's project) |
| `GCP_BQ_MAX_BYTES_BILLED` | Per-query BigQuery scan cap (default 5 GiB) |
| `GCP_MONITOR_DB_PATH` | History database file (default `~/.gcp-monitor-mcp/history.db`) |
| `GCP_MONITOR_HISTORY_DAYS` | Days of history to keep (default 400) |
| `GCP_MONITOR_HISTORY` | `off` removes the history tools |

## Development

- Never write to stdout (`console.log`): it is the MCP channel. Log with `console.error`.
- Tests use the SDK's `InMemoryTransport` and fake BigQuery / App Optimize clients, so they need no GCP access: `npm test`.

## Roadmap

- [x] Language and SDK: JavaScript (ESM), `@modelcontextprotocol/sdk`, `zod`
- [x] Scaffolding, start command, tests
- [x] Cost tools (summary, trend, top resources)
- [x] App Optimize API as a cost source (no billing access needed)
- [x] Resource inventory (Cloud Asset Inventory)
- [x] Usage metrics (Cloud Monitoring): VMs, GKE, Cloud SQL, Cloud Run
- [x] Service health: Cloud SQL, GKE, VMs, incidents, logs, uptime
- [x] Local history: daily snapshots, saved reports, finding recurrence, metric trends
- [x] Day-aligned capture of all data, anomaly detection on history, backfill CLI, scheduled FinOps and health reports
- [ ] Budgets and Recommender (idle resources, rightsizing)
- [ ] Package as a Claude Desktop extension (`.mcpb`)

## License

Not yet chosen.

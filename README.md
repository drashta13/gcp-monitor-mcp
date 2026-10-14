# gcp-monitor-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets Claude and other MCP clients monitor Google Cloud: what you spend, what's running, and how it's behaving, across all your projects, from a conversation.

> **Status: v0.5.1.** Cost (with week-over-baseline anomalies), inventory, usage metrics and service health (Cloud SQL, GKE, VMs, incidents, logs).

## Tools

The server is **read-only**. Every tool is annotated `readOnlyHint`.

| Tool | Status | What it does |
|------|--------|--------------|
| `list_projects` | ✅ | Active projects this server can read (filtered by the allowlist, if set) |
| `get_cost_summary` | ✅ | Spend for a date range grouped by `service`, `project`, `sku` or `region` |
| `get_cost_trend` | ✅ | Net spend as daily, weekly or monthly points |
| `get_cost_comparison` | ✅ | This week vs the 3 weeks before, per day, by service and resource, with anomalies flagged (spikes, big increases, new and stopped spend). Built for a weekly FinOps report |
| `get_top_cost_resources` | ✅ | The individual resources that cost the most |
| `list_resources` | ✅ | Active resources across projects (VMs, GKE, Cloud SQL, Cloud Run, functions, Redis, buckets...) via Cloud Asset Inventory |
| `get_resource_usage` | ✅ | CPU, memory, pods, connections, requests... per resource from Cloud Monitoring, as avg / max / latest |
| `get_cloudsql_health` | ✅ | HA/failover, backups and PITR, backup runs, maintenance, plus uptime, CPU, memory, disk, connections, IOPS |
| `get_gke_health` | ✅ | Versions and skew, release channel, node pools and autoscaling, OOM / crash-loop / scheduling events, autoscaler decisions, restarts |
| `get_vm_health` | ✅ | OS and patch status (vulnerabilities), OS Config and Ops Agent health, snapshot coverage, CPU / memory / disk, unattached disks |
| `get_incidents` | ✅ | Alerting-policy incidents with duration, Google Cloud outages affecting you (Service Health), uptime-check availability |
| `query_logs` | ✅ | Cloud Logging search with presets (errors, k8s_warnings, oom, crashloop, changes, cloudsql, autoscaler) for root-cause evidence |

Cost tools accept `startDate` / `endDate` (UTC, default month to date), `projectIds` and `service` filters.

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

- **Costs come from one of two sources.** The App Optimize API (what Cost Explorer uses) needs no billing access but shows list prices for the last 30 days. The Cloud Billing export to BigQuery is exact (credits and discounts applied) and keeps history. Both lag usage by up to a day.
- **Queries are parameterized** and the group-by/granularity options are whitelisted, so tool input never becomes SQL text. Each query filters on `_PARTITIONTIME` and is capped by `maximumBytesBilled`.
- **Errors come back as tool errors with a fix**, e.g. missing credentials suggests the `gcloud` command and permission errors name the role.

## Documentation

Full docs are in [`docs/`](docs/README.md):

- [About the project](docs/overview.md): architecture, design decisions, data sources and limits
- [Google Cloud setup](docs/gcp-setup.md): service account, roles per project, APIs, cost source
- [Local setup](docs/local-setup.md): install, log in, configure, run, troubleshoot
- [Connect it to Claude](docs/claude-setup.md): Claude Desktop and Claude Code, example prompts
- [Tools reference](docs/tools.md): every tool's inputs, outputs and how it works
- [Security](docs/security.md): pitfalls to avoid

## Quick start

```bash
# 1. Google Cloud: a read-only service account you can impersonate (details: docs/gcp-setup.md)
gcloud iam service-accounts create mcp-reader --project=my-main-project
gcloud iam service-accounts add-iam-policy-binding mcp-reader@my-main-project.iam.gserviceaccount.com \
  --member="user:you@example.com" --role="roles/iam.serviceAccountTokenCreator"
# ...grant Viewer in each project, plus App Optimize Admin in my-main-project

# 2. Local
npm install && npm test
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
- [ ] Budgets and Recommender (idle resources, rightsizing)
- [ ] Package as a Claude Desktop extension (`.mcpb`)

## License

Not yet chosen.

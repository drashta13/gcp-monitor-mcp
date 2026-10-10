# gcp-monitor-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets Claude and other MCP clients monitor Google Cloud infrastructure: query metrics, search logs, inspect alerting policies and incidents, and check resource health, all from a conversation.

> **Status: early planning.** This repository currently contains only this README. No server code has been written yet, so everything below under *Features*, *Installation* and *Usage* describes the intended design and is marked **(planned)**. The GCP authentication section describes how Google Cloud credentials work and will apply once the server exists.

## Why

Investigating a production issue on GCP usually means jumping between Cloud Monitoring dashboards, Logs Explorer, the alerting console and per-service pages. Exposing those read paths as MCP tools lets an assistant pull the relevant data together, correlate it, and summarize what is going on, without anyone copying numbers between browser tabs.

## Features (planned)

The server is intended to be **read-only** by default. Planned tools:

| Area | Tool (planned) | What it does |
|------|----------------|--------------|
| Metrics | `list_metric_descriptors` | Find available metric types for a project, with optional filter |
| Metrics | `query_time_series` | Fetch time series for a metric over a time window, with aggregation (e.g. CPU, latency, error rate) |
| Logs | `query_logs` | Run a Cloud Logging filter over a time range and return matching entries |
| Logs | `summarize_errors` | Group recent `severity>=ERROR` entries by resource and message |
| Alerts | `list_alert_policies` | List alerting policies and whether they are enabled |
| Alerts | `list_incidents` | Show open and recently closed alert incidents |
| Health | `list_resources` | Inventory key resources (Compute Engine, GKE, Cloud Run, Cloud SQL) in a project |
| Health | `resource_health` | Report status and recent signals for a single resource |
| Uptime | `list_uptime_checks` | Show uptime checks and their latest results |

Possible later additions: GCP Service Health / status page incidents, Error Reporting groups, and cost/billing anomalies.

## Requirements (planned)

- A Google Cloud project with the **Cloud Monitoring API** and **Cloud Logging API** enabled (plus Cloud Asset Inventory API if `list_resources` uses it)
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) for local authentication
- An MCP client such as Claude Desktop or Claude Code
- The runtime/language for the server has not been chosen yet

## Authentication

The server will use Google's standard [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials), so it picks up credentials the same way the official client libraries do.

**Option 1: your own user account (local development)**

```bash
gcloud auth application-default login
```

**Option 2: a service account (shared or automated use)**

Create a service account with read-only roles, download a key (or better, use workload identity / impersonation where available), and point ADC at it:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

Recommended read-only IAM roles for the identity the server runs as:

- `roles/monitoring.viewer` for metrics, alert policies, incidents and uptime checks
- `roles/logging.viewer` for logs (add `roles/logging.privateLogViewer` only if you need Data Access audit logs)
- `roles/cloudasset.viewer` for resource inventory (if used)
- `roles/browser` to list projects

Avoid granting editor or owner roles; the server only needs to read.

## Configuration (planned)

| Variable | Purpose |
|----------|---------|
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service account key, if not using `gcloud` user credentials |
| `GCP_PROJECT_ID` | Default project to query when a tool call does not specify one |
| `GCP_MONITOR_ALLOWED_PROJECTS` | Optional comma-separated allowlist of projects the server may query |

## Usage with Claude (planned)

Once the server is implemented, it will be registered as a standard stdio MCP server.

**Claude Code**

```bash
claude mcp add gcp-monitor -e GCP_PROJECT_ID=my-project -- <command to start the server>
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "gcp-monitor": {
      "command": "<command to start the server>",
      "env": {
        "GCP_PROJECT_ID": "my-project"
      }
    }
  }
}
```

The exact start command will be filled in once the implementation and packaging are decided.

Example prompts:

- "What's the p95 latency for the `checkout` Cloud Run service over the last 6 hours?"
- "Are there any open alert incidents in `my-project`?"
- "Summarize the errors from GKE cluster `prod-1` since 9am."
- "Which Compute Engine instances have had CPU above 90% today?"

## Roadmap

- [ ] Choose language and MCP SDK
- [ ] Project scaffolding, packaging and start command
- [ ] Metrics tools
- [ ] Logging tools
- [ ] Alerting and incident tools
- [ ] Resource inventory and health tools
- [ ] Tests and example configuration

## License

Not yet chosen.

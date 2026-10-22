# Tools reference

All 25 tools: what each one is for, its inputs, what it returns, and how it works underneath. Every Google Cloud tool is **read-only** (`readOnlyHint: true`). The two history tools that write (`capture_snapshot`, `save_report`) only append to the local history file. All tools return compact JSON as text.

| Group | Tool | Use it for |
|---|---|---|
| Discovery | [`list_projects`](#list_projects) | Which projects the server can read |
| | [`list_resources`](#list_resources) | What's running, across projects |
| Cost | [`get_cost_summary`](#get_cost_summary) | Spend for a period, by service / project / SKU / region |
| | [`get_cost_trend`](#get_cost_trend) | Spend over time: daily, weekly, monthly |
| | [`get_top_cost_resources`](#get_top_cost_resources) | The most expensive individual resources |
| | [`get_cost_comparison`](#get_cost_comparison) | This week vs the previous weeks, with anomalies (weekly FinOps report) |
| Usage | [`get_resource_usage`](#get_resource_usage) | CPU, memory, pods, connections, requests, uptime per resource |
| Health | [`get_cloudsql_health`](#get_cloudsql_health) | Cloud SQL HA, backups, PITR, maintenance, load |
| | [`get_gke_health`](#get_gke_health) | GKE versions, node pools, warning events, autoscaler, restarts |
| | [`get_vm_health`](#get_vm_health) | VM patches, agents, snapshots, load, unattached disks |
| | [`get_incidents`](#get_incidents) | Alert incidents, Google Cloud outages, uptime |
| | [`query_logs`](#query_logs) | Log search for root cause |
| History | [`capture_snapshot`](#capture_snapshot) | Record everything about one day: cost, incidents, health, workloads, logs, inventory (scheduled daily run) |
| | [`save_report`](#save_report) | Save a written report and its findings |
| | [`list_history`](#list_history) / [`get_history`](#get_history) | Browse past reports and snapshots |
| | [`search_findings`](#search_findings) | Is this issue new or recurring? Since when? |
| | [`find_anomalies`](#find_anomalies) | Anything unusual on a day, vs the 14 normal days before |
| | [`add_event`](#planned-events-sales) / [`list_events`](#planned-events-sales) / [`delete_event`](#planned-events-sales) | Sales calendar: planned scale-ups that anomaly checks expect |
| | [`review_event`](#review_event) | A sale's cost, what scaled up, and what wasn't scaled down after it |
| | [`get_metric_history`](#get_metric_history) | Cost and utilization trends over months |
| | [`diff_snapshots`](#diff_snapshots) | What changed between two days |
| | [`query_history_sql`](#query_history_sql) | Read-only SQL over the history |

## Conventions

These apply to every tool.

**Project scope.** Most tools take `projectIds` (array, at most 50, duplicates ignored). If you leave it out, the tool covers every project in `GCP_MONITOR_ALLOWED_PROJECTS`, or, with no allowlist, every project the service account can see (cost tools on the App Optimize source: only `GCP_COST_REPORT_PROJECT`). A project outside the allowlist, or an ID that is not a valid Google Cloud project ID, is refused with an error.

**Partial results.** Tools query projects in parallel (2 to 8 at a time, depending on the tool). One failing project doesn't fail the call:

| Field | Meaning |
|---|---|
| `failedProjects: [{ projectId, error }]` | That project errored (permission, quota...). The rest of the result is still valid |
| `apiNotEnabledIn: [projectId]` | The service's API is off in that project, which usually means the project doesn't use it. Not an error |

The call only fails as a whole when every project fails.

**Errors.** Failures come back as a tool error with a hint about the fix (missing credentials → the `gcloud` command; permission denied → the role; API disabled → which API).

**Slow calls.** The cost tools, the four health tools and `query_logs` run as *background jobs*. They wait up to 45 s; if the work isn't done they return:

```json
{ "status": "running", "runningForSeconds": 45, "message": "Call this tool again with exactly the same arguments in about 30 seconds..." }
```

Calling again with **identical arguments** returns the finished result. Identical calls share one run. Cost results are cached for 10 minutes; health and log results for 2 minutes (they are "as of now"). A failure is not cached: if the job failed while you were waiting you get the error straight away, and if it failed after you got `running`, the next call with the same arguments returns the error once and then starts over.

**Past windows.** `get_resource_usage`, the health tools, `get_incidents` and `query_logs` take `endTime` (ISO 8601, e.g. `2026-10-13T00:00:00-07:00`) so the `hours` window ends then instead of now. Configuration (backups, versions, patches) is always as of now; metrics, events, alerts and logs follow the window. Cloud Monitoring keeps 6 weeks of metrics and Cloud Logging usually 30 days of logs.

**Metric summaries.** Wherever a metric appears, it's `{ avg, max, latest }` over the window, from about 48 aligned points. Counters are `{ total }`, and "agent present" is `{ reporting: true }`. A metric with no data is left out.

**Cost data caveats (App Optimize source).** List or contract prices **before** credits and committed-use discounts. History reaches back about a year (measured October 2026); a day older than that comes back empty rather than as an error. Days are in Pacific Time. Data lags usage by up to a day. The BigQuery export source is exact and returns `netCost` (`cost + credits`) and `dataAsOf`.

---

## Discovery

### `list_projects`

Active projects the server can read. Use it first to find project IDs.

**Inputs:** none.

**Output**

```json
{ "count": 4, "projects": [{ "projectId": "proj-a", "name": "Project A", "parent": "organizations/123", "labels": { "env": "prod" } }] }
```

**How:** Resource Manager project search as the service account, filtered by the allowlist.

### `list_resources`

Inventory of what's deployed across projects, from Cloud Asset Inventory. By default it returns only active resources; stopped, terminated or failed ones are left out but still counted.

| Input | Type | Default | Notes |
|---|---|---|---|
| `projectIds` | string[] | all allowed | |
| `kinds` | enum[] | `vm, gke, cloudsql, cloudrun, functions, redis, bucket` | Also `disk`, `bigquery` (datasets), `loadbalancer` (forwarding rules) |
| `includeInactive` | boolean | `false` | Include stopped/terminated/failed, each with `active: false` |
| `limit` | 1-1000 | 200 | |

**Output**

```json
{
  "projects": ["proj-a", "proj-b"],
  "counts": { "vm": { "active": 7, "inactive": 4 }, "gke": { "active": 3, "inactive": 0 } },
  "returned": 42, "truncated": false,
  "resources": [{
    "kind": "vm", "name": "api-server", "projectId": "proj-a", "location": "asia-south1-a",
    "state": "RUNNING", "labels": { "team": "web" }, "created": "2025-11-27T06:23:34.000Z",
    "usageKind": "vm",
    "resourceName": "//compute.googleapis.com/projects/proj-a/zones/asia-south1-a/instances/api-server"
  }]
}
```

`usageKind` tells you which `get_resource_usage` kind has metrics for that resource.

**How:** `searchAllResources` per project, filtered by asset type. "Active" means the state isn't one of TERMINATED, STOPPED, SUSPENDED, FAILED, DELETING and similar. Resources with no state (buckets, datasets) count as active.

---

## Cost

`get_cost_summary`, `get_cost_trend` and `get_top_cost_resources` share these inputs:

| Input | Type | Default | Notes |
|---|---|---|---|
| `startDate` | `YYYY-MM-DD` | first day of this month | inclusive |
| `endDate` | `YYYY-MM-DD` | today | inclusive |
| `projectIds` | string[] | all allowed | |
| `service` | string | all | billing service name, e.g. `"Compute Engine"`, `"Cloud Run"`, `"BigQuery"` |

**How (App Optimize):** for each project in scope (at most 4 at a time), the server creates an App Optimize report in `GCP_COST_REPORT_PROJECT` with the dimensions and filters the tool needs, waits for it, pages through the rows, deletes the report, and merges the rows across projects. One report per project is needed because the API accepts only one scope per report.

**How (BigQuery export):** one parameterized SQL query over the export table. Group-by and granularity are whitelisted, never interpolated from input. It filters on `_PARTITIONTIME` and is capped by `GCP_BQ_MAX_BYTES_BILLED`.

### `get_cost_summary`

Total spend for a date range, broken down by one dimension, highest first.

| Extra input | Type | Default |
|---|---|---|
| `groupBy` | `service` \| `project` \| `sku` \| `region` | `service` |
| `limit` | 1-100 | 25 |

**Output**

```json
{
  "startDate": "2026-10-01", "endDate": "2026-10-11", "timezone": "America/Los_Angeles",
  "source": "app-optimize", "pricing": "list/contract prices before credits and committed-use discounts",
  "groupBy": "service",
  "totals": { "INR": { "cost": 216106.4, "groups": 23 } },
  "rows": [{ "service": "Cloud SQL", "cost": 61234.5, "currency": "INR" }]
}
```

With the BigQuery source, rows also have `credits` and `netCost`, plus `dataAsOf`.

**Use for:** "what did we spend this month and on what", per-project chargeback, region split.

### `get_cost_trend`

Spend as a time series.

| Extra input | Type | Default |
|---|---|---|
| `granularity` | `day` \| `week` \| `month` | `day` |

**Output**

```json
{ "granularity": "day", "service": "all",
  "points": [{ "period": "2026-10-01", "cost": 21034.2, "currency": "INR" }] }
```

Weeks start on Monday. **Use for:** spotting spikes, before/after a change, month-over-month.

### `get_top_cost_resources`

The individual resources that cost the most in the range.

| Extra input | Type | Default |
|---|---|---|
| `limit` | 1-100 | 20 |

**Output**

```json
{ "rows": [{
  "resource": "//cloudsql.googleapis.com/projects/proj-a/instances/fsdev",
  "service": "Cloud SQL", "projectId": "proj-a",
  "resourceType": "sqladmin.googleapis.com/Instance", "cost": 32705.5, "currency": "INR" }] }
```

With the BigQuery source this needs the *Detailed usage cost* export. **Use for:** finding what to rightsize or delete. Pair it with `get_resource_usage` to see if the expensive thing is actually busy.

### `get_cost_comparison`

Current period vs a baseline before it, per day, by service and by resource, with anomalies flagged. Built for a weekly FinOps report. App Optimize source only.

| Input | Type | Default | Notes |
|---|---|---|---|
| `days` | 1-14 | 7 | length of the current period |
| `baselineDays` | 3-28 | 21 | length of the baseline right before it |
| `endDate` | `YYYY-MM-DD` | 2 days ago (Pacific) | last day of the current period. Today is partial and yesterday may still be filling in |
| `threshold` | 5-1000 | 25 | per-day % change that counts as an increase/decrease |
| `limit` | 1-100 | 15 | max rows in each of `anomalies`, `services`, `resources` |
| `projectIds`, `service` | | | as above |

Both windows must fit in App Optimize's history (about the last 365 days).

**Output**

```json
{
  "currency": "INR",
  "current":  { "startDate": "2026-10-06", "endDate": "2026-10-12", "days": 7,  "total": 146333.31, "perDay": 20904.76 },
  "baseline": { "startDate": "2026-09-15", "endDate": "2026-10-05", "days": 21, "total": 543348.45, "perDay": 25873.74 },
  "changePct": -19.2, "deltaPerDay": -4968.98,
  "thresholds": { "increasePct": 25, "minDeltaPerDay": 129.37, "spike": "day above baseline mean + 3 SD" },
  "anomalies": [{ "type": "new", "scope": "resource", "name": "//storage.googleapis.com/fslife",
                  "service": "Cloud Storage", "projectId": "proj-c",
                  "currentPerDay": 598.34, "baselinePerDay": 0, "deltaPerDay": 598.34, "changePct": null }],
  "services":  [{ "service": "Cloud SQL", "current": 38193.61, "currentPerDay": 5456.23, "baselinePerDay": 6011.09,
                  "deltaPerDay": -554.86, "changePct": -9.23 }],
  "resources": [{ "resource": "//container.googleapis.com/.../clusters/web", "service": "Google Kubernetes Engine",
                  "currentPerDay": 1901.8, "baselinePerDay": 4083.78, "changePct": -53.43, "flags": ["decrease"] }]
}
```

**How it decides what's an anomaly**

- Everything is compared **per day**, so a 7-day week and a 21-day baseline compare fairly.
- **Noise floor:** changes smaller than 0.5% of total daily spend (`minDeltaPerDay`) are ignored.
- `increase` / `decrease`: per-day change of at least `threshold` %.
- `new`: no spend in the baseline. `stopped`: no spend in the current period.
- `spike` (services only): a day in the current period above the baseline mean + 3 standard deviations **and** above that week's median. A steady step up reads as one increase, not seven spikes. The flag lists `spikeDays` and replaces `increase` for that service.
- BigQuery jobs are folded into one row per project (`.../jobs/*`), so thousands of small jobs don't crowd out real resources.

**How:** 3 App Optimize runs in parallel: service × day across both windows (for spikes), and resource totals for each window.

---

## Usage

### `get_resource_usage`

Utilization for one kind of resource across projects, from Cloud Monitoring, busiest first.

| Input | Type | Default | Notes |
|---|---|---|---|
| `kind` | `vm` \| `gke` \| `cloudsql` \| `cloudrun` \| `uptime` \| `logs` | **required** | |
| `projectIds` | string[] | all allowed | |
| `hours` | 1-1008 | 24 | max 6 weeks |
| `endTime` | ISO 8601 | now | end of the window |
| `names` | string[] | all | VM, cluster, instance, service or check names |
| `breakdown` | `resource` \| `namespace` | `resource` | `gke` only: one row per cluster × namespace |
| `limit` | 1-200 | 50 | |

**Metrics per kind**

| Kind | Metrics | Sorted by |
|---|---|---|
| `vm` | `cpuPercent`, `memoryPercent`\*, `diskPercent`\* (fullest disk; loop/tmpfs mounts ignored), `networkInMiBps`, `networkOutMiBps`, `opsAgent`\* | CPU |
| `gke` | `cpuCores`, `memoryMiB`, `pods`, `containerRestarts` (total), `nodes`, `nodeCpuPercent`, `nodeMemoryPercent` | CPU cores |
| `cloudsql` | `uptimePercent`, `cpuPercent`, `memoryPercent`, `diskPercent`, `connections`, `readIops`, `writeIops` | CPU |
| `cloudrun` | `cpuPercentP95`, `memoryPercentP95`, `requestsPerSec`, `instances` | requests |
| `uptime` | `availabilityPercent` (share of checks passed), `latencyMs` | worst availability first |
| `logs` | `entries` (total): exact count of WARNING, ERROR, CRITICAL, ALERT and EMERGENCY log entries, one row per resource type (`name`) and `severity` | most entries |

\* Needs the Ops Agent on the VM.

**Output**

```json
{
  "kind": "cloudsql", "breakdown": "resource",
  "window": { "hours": 24, "start": "...", "end": "...", "alignmentSeconds": 1800 },
  "metrics": { "cpuPercent": "cloudsql.googleapis.com/database/cpu/utilization" },
  "returned": 2, "truncated": false,
  "resources": [{ "name": "fsdev", "projectId": "proj-a", "location": "asia-south1",
                  "metrics": { "cpuPercent": { "avg": 2.09, "max": 2.86, "latest": 2.22 },
                               "memoryPercent": { "avg": 88.51, "max": 89.31, "latest": 89.28 } } }]
}
```

**How:** `timeSeries.list` per metric and project, aligned to about 48 points and grouped server-side (`groupBy`) so each resource is one series. **Use for:** idle resources (low CPU + high cost), overloaded ones, namespace hogs, capacity planning.

---

## Health

The four health tools return one row per resource with an **`issues`** list of plain-language problems, sorted most issues first. Each row also includes its live metrics from `get_resource_usage`. They share these inputs:

| Input | Type | Default |
|---|---|---|
| `projectIds` | string[] | all allowed |
| `names` | string[] | all (not on `get_incidents`) |
| `hours` | int | 24 (`get_incidents`: 168). Max 1008 (6 weeks) for `get_cloudsql_health`, `get_vm_health` and `get_incidents`; 720 (30 days) for `get_gke_health`, which also reads logs |
| `endTime` | ISO 8601 | now: the end of the `hours` window |
| `limit` | int | 100, max 500 (`get_cloudsql_health`, `get_vm_health`). The output has `returned` and `truncated` |

When a metric Cloud Monitoring rejected is involved, the output carries `metricErrors: [{ projectId, metric, type, error }]` rather than silently leaving the metric out.

### `get_cloudsql_health`

Cloud SQL configuration and load.

**Per instance:** `databaseVersion`, `tier`, `region`, `zone`, `state`, `role` (primary / read replica of X), `highAvailability`, `failover` (`availabilityType`, `secondaryZone`, `replicas`), `backups` (`enabled`, `pointInTimeRecovery`, `logRetentionDays`, `retainedBackups`, `startTime`, `lastSuccessful`, `recentFailures`), `storage` (`sizeGb`, `autoResize`), `maintenance` (window, scheduled), `deletionProtection`, `metrics`, `issues`.

**Flags as issues:** not RUNNABLE, stopped, zonal (no automatic failover), backups off, PITR off, last successful backup over 36 h ago, failed backup runs, auto-resize off, deletion protection off, disk ≥ 85%, uptime < 100%, CPU ≥ 80%, memory ≥ 90%, maintenance scheduled.

```json
{ "summary": { "instances": 2, "withIssues": 2, "highAvailability": 0 },
  "instances": [{ "name": "fsdev", "highAvailability": false,
    "backups": { "enabled": true, "pointInTimeRecovery": true, "lastSuccessful": "2026-10-13T23:41:19Z" },
    "issues": ["no high availability (zonal): no automatic failover", "deletion protection is off"] }] }
```

**How:** SQL Admin API `instances.list` and `backupRuns.list` (latest 20) per instance, plus Cloud SQL metrics.

### `get_gke_health`

GKE cluster versions, node pools, Kubernetes warning events, autoscaler activity and load.

**Per cluster:** `status`, `mode` (autopilot/standard), `versions` (control plane, nodes, release channel), `nodeCount`, `nodePools` (standard: per pool version, status, machine type, autoscaling min/max, auto-upgrade/repair, spot; Autopilot: a summary, because Google manages the pools), `events` (count by reason: `OOMKilling`, `BackOff`, `CrashLoopBackOff`, `Unhealthy`, `FailedScheduling`, `Evicted`, `NodeNotReady`, `FailedMount`), `autoscaling` (`scaleUp`, `scaleDown`, `scaleUpBlocked`), `metrics`, `issues`.

**Flags as issues:** cluster not running or with error conditions, no release channel, node pool version on a different minor than the control plane, auto-repair off (standard), OOM kills, crash loops, scheduling failures, evictions, node-not-ready (unless explained by scale-downs), blocked scale-ups, ≥ 10 container restarts, node CPU ≥ 80%, node memory ≥ 85%.

`Unhealthy` is counted but not flagged: it's normal during rollouts and probes. (`Killing` is not counted: it is a Normal event on every pod stop.) Use `query_logs` with preset `k8s_warnings` or `oom` and `resourceName: "<cluster>"` to see the individual events, and `get_resource_usage` kind `gke` with breakdown `namespace` for per-workload load.

**How:** GKE API `clusters.list` across all locations, Cloud Logging counts of the `events` log and the `cluster-autoscaler-visibility` log in the window, plus GKE metrics.

### `get_vm_health`

Compute Engine VM state, OS and patches, agents, snapshots and load.

**Per VM:** `status`, `machineType`, `zone`, `lastStart`, `os` (name, version, kernel; needs VM Manager), `patches` (vulnerability counts by severity; needs VM Manager), `agents` (`osConfig`, `opsAgent`), `disks` (per disk: size, type, `lastSnapshot`, `snapshotAgeDays`, `snapshotSchedule`), `metrics`, `issues`.

**Also returns** `unattachedDisks` (disks not attached to any VM, which you pay for unused), and `vmManagerOffIn` with a link if VM Manager is disabled in a project. GKE node VMs are skipped by default (`summary.gkeNodesSkipped` says how many): they have no snapshot schedules, OS Config or Ops Agent by design and `get_gke_health` covers them. Pass `includeGkeNodes: true` to list them anyway (each marked `gkeNode: true`).

**Flags as issues:** not running, a disk with no snapshot schedule and no snapshot in 7 days, OS Config agent not reporting (when VM Manager is on), OS data older than 48 h, Ops Agent not reporting, critical/high vulnerabilities, disk ≥ 85%, memory ≥ 90%, CPU ≥ 85%.

**How:** Compute aggregated `instances`, `disks` and `resourcePolicies` (snapshot schedules) plus `snapshots`. OS Config `inventories` and `vulnerabilityReports` per zone. VM metrics.

### `get_incidents`

What went wrong in the window.

**Output**

| Field | Contents |
|---|---|
| `summary` | `incidents`, `open`, `googleCloudEvents`, `uptimeChecks` |
| `byPolicy` | per alerting policy: `count`, `open`, `totalMinutes`, `severity` |
| `alertsTruncatedIn` | projects where more than 500 matching alerts exist; counts there are lower bounds |
| `incidents` | up to 100 alert incidents, newest first: `policy`, `severity`, `state`, `openTime`, `closeTime`, `durationMinutes`, `resource`, `metric`, `projectId` |
| `googleCloudEvents` | Google Cloud outages relevant to your projects (Personalized Service Health): `title`, `state`, `detailedState`, `relevance`, `startTime`, `endTime`, `products`, `locations`, `description`. `{ unavailable: "..." }` if the API is off everywhere |
| `availability` | uptime checks with `availabilityPercent` and `latencyMs` |

Incidents only exist for metrics you have **alerting policies** on, and availability only for **uptime checks** you've created. Google Cloud doesn't record root cause, so follow each incident with `query_logs` around its `openTime`.

**How:** Monitoring v3 `alerts.list` (open, or opened in the window), Service Health `events.list`, and uptime-check metrics.

### `query_logs`

Cloud Logging search across projects, newest first, for root-cause evidence.

| Input | Type | Default | Notes |
|---|---|---|---|
| `projectIds` | string[] | all allowed | |
| `preset` | see below | none | a ready-made filter |
| `filter` | string ≤ 2000 | none | [Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language), ANDed with the preset |
| `resourceName` | string ≤ 200 | none | free-text match of a cluster/instance/service name anywhere in the entry |
| `hours` | 1-720 | 24 | |
| `endTime` | ISO 8601 | now | end of the window |
| `limit` | 1-200 | 50 | |

| Preset | Finds |
|---|---|
| `errors` | `severity>=ERROR` from anything |
| `k8s_warnings` | Kubernetes warning events |
| `oom` | OOM kills (Kubernetes events) |
| `crashloop` | `BackOff` / `CrashLoopBackOff` events |
| `changes` | Admin Activity audit log: who changed what (deploys, config edits, resizes, deletes), without Kubernetes control-plane chatter and Google service agents |
| `cloudsql` | Cloud SQL warnings and errors |
| `autoscaler` | GKE cluster autoscaler decisions |

**Output**

```json
{
  "filter": "timestamp>=\"...\" AND severity>=ERROR",
  "window": { "hours": 24, "since": "..." }, "returned": 50, "truncated": true,
  "bySeverity": { "ERROR": 50 },
  "byResource": { "k8s_container:web/prod/web-58bd-w8d6v": 12 },
  "entries": [{ "timestamp": "...", "severity": "ERROR", "projectId": "proj-a", "log": "stderr",
                "resource": { "type": "k8s_container", "name": "web/prod/web-58bd-w8d6v" },
                "message": "fetchProduct_error — Product not found",
                "audit": { "method": "...", "principal": "dev@example.com" }, "reason": "OOMKilling" }]
}
```

Messages are cut to 500 characters. `filter` is echoed so you can paste it into Logs Explorer. Data Access audit logs and other private logs aren't readable with Viewer.

**Use for:** "what happened at 14:05?", "who changed the cluster yesterday?", "which pods are OOMing?".

---

## History

A local SQLite database (`GCP_MONITOR_DB_PATH`, default `~/.gcp-monitor-mcp/history.db`) that a scheduled daily capture fills with everything about one day, so any later chat or report can look back. Nothing in it is sent anywhere except as tool results, like every other tool. Rows older than `GCP_MONITOR_HISTORY_DAYS` (default 400) are pruned after each capture. `GCP_MONITOR_HISTORY=off` removes these tools. Scheduled tasks and their prompts: [Scheduled tasks](scheduled-tasks.md).

**One snapshot per day.** A snapshot describes one calendar day in the cost source's time zone (Pacific on App Optimize, UTC on the BigQuery export): cost for that billing day, and metrics, incidents and logs for its 24 hours (23 or 25 on daylight-saving switch days). Days older than Cloud Logging's usual 30-day retention mark `logs` and `gke` as `partial` (log samples and GKE event counts are incomplete; admin-audit "changes" are kept 400 days), so expired logs never read as "nothing happened". Configuration (backups, versions, patches, inventory) is as of capture time; for a past day, resources created after it are left out and resources deleted since keep their metrics (except Google-managed node VMs: GKE `gke-`/`gk3-` nodes, which GKE reports per cluster, and Serverless VPC Access `aet-` connectors). A snapshot always covers every configured project.

**Section status.** `ok`; `partial` (some projects, metrics or log presets failed: the data is kept but incomplete); `skipped` (not available on this setup); `error`. Capturing a day again replaces a section only when the new result is at least as good as the stored one, so a failed retry never wipes out good data, and `sections: [...]` retries just the failed ones. A day counts as missing (in `missingDays` and `--missing`) when it has no snapshot, nothing usable, or a failed cost section.

**What's stored**

| Table | One row per | Notes |
|---|---|---|
| `snapshots` | day | date, window start/end, cost source, sections and their status, errors, summary |
| `snapshot_results` | section of a day | The raw JSON the cost / health / usage / log tool returned, so a past day can be re-read in full |
| `metrics` | day × resource × metric | All keyed by the day they describe. Re-capturing overwrites, so late cost data gets corrected |
| `findings` | issue seen | From snapshots (every health `issues[]` entry, incident, Google Cloud event, uptime below 100%, cost comparison anomaly, unattached disk, and statistical anomalies against the previous 14 days) and from reports (what Claude concluded). Severity is `high` / `medium` / `low` |
| `reports` | `save_report` call | Title, summary, full Markdown, linked snapshot, tags |

**Metric kinds**

| Kind | Resource | Metrics |
|---|---|---|
| `cost_total` | `total` | `dailyCost` (also the 6 days before, refreshed each capture), `weekPerDay`, `baselinePerDay` |
| `cost_service`, `cost_project`, `cost_sku`, `cost_region`, `cost_resource` | service, project, SKU, region, resource | `dailyCost` (unit = currency) |
| `incidents` | `total` or alert policy | `alerts`, `open`, `minutes` |
| `uptime` | uptime check | `availabilityPercent.avg`, `latencyMs.avg` ... |
| `cloudsql`, `vm`, `gke`, `cloudrun` | instance, VM, cluster, service | every metric of the health / usage tools as `<metric>.avg / .max / .latest / .total`, e.g. `cpuPercent.avg`, `diskPercent.latest`, `connections.avg`, `readIops.avg`, `containerRestarts.total`, `requestsPerSec.avg`; GKE also `events.<reason>` (OOMKilling, BackOff...) and `autoscaler.scaleUp / scaleDown / scaleUpBlocked`; resource `total` has `withIssues` (and `unattachedDisks` for VMs) |
| `gke_namespace` | `cluster/namespace` | `cpuCores.*`, `memoryMiB.*`, `pods.*`, `containerRestarts.total` |
| `logs` | `<resource type>/<severity>` | `entries.total`: exact count of WARNING-or-worse log entries |
| `log_preset` | `query_logs` preset | `entries`: entries sampled (at most 200) |
| `inventory` | resource kind | `active`, `inactive` per project |

App Optimize costs are list prices before credits; the BigQuery export is net of credits.

**Recurrence.** Each finding has a *fingerprint*: category + project + resource + title with numbers replaced, so "disk 91% full" on Monday and "disk 93% full" on Tuesday are the same issue. `search_findings`, `diff_snapshots` and the capture's "since last snapshot" all use it. For report findings, keep titles stable and put changing numbers in `detail`.

**Severity rules for health issues.** High: wrong state/status, backups off or failing, no successful backup, uptime below 100% on Cloud SQL, OOM kills, crash loops, scheduling failures, blocked scale-ups, critical vulnerabilities, open alerts, active Google Cloud events, uptime checks below 99%. Medium: disk/CPU/memory over threshold, high vulnerabilities, stale backups, no PITR, no HA, restarts, evictions, missing snapshot schedules, version skew, agents not reporting, closed alerts, uptime checks below 100%, cost spikes and increases, statistical spikes in cost, errors and restarts. Low: everything else (deletion protection off, stopped VMs, new/decreased/stopped spend, unattached disks, other statistical anomalies).

### `capture_snapshot`

Collects everything about one day and stores it.

**Inputs:** `day` (YYYY-MM-DD in the cost source's time zone; default 2 days ago, the last complete day), `sections` (default all).

| Section | Runs |
|---|---|
| `cost` | `get_cost_summary` by service and by project for the day, and `get_cost_trend` daily for the week to it |
| `costSku`, `costRegion` | `get_cost_summary` by SKU (300 rows) and by region |
| `costResources` | `get_top_cost_resources` (300 rows); *skipped* on a standard BigQuery export |
| `costComparison` | `get_cost_comparison`, 7 days ending on the day vs the 21 before, threshold 25%; App Optimize only (*skipped* on BigQuery) |
| `incidents` | `get_incidents` for the day: alerts open at any time during it, Google Cloud events, uptime checks |
| `cloudsql`, `gke`, `vm` | the health tools for the day |
| `gkeWorkloads` | `get_resource_usage` kind `gke`, breakdown `namespace` |
| `cloudrun` | `get_resource_usage` kind `cloudrun` |
| `logVolume` | `get_resource_usage` kind `logs`: exact WARNING+ counts per resource type and severity |
| `logs` | `query_logs` for every preset (errors, k8s_warnings, oom, crashloop, changes, cloudsql, autoscaler), 200 newest entries each |
| `inventory` | `list_resources`, every kind, including inactive resources |

Cost sections run one after another; the others run 4 at a time. A section that fails is listed in `errors` and the rest is still saved; one that isn't available on this setup is `skipped`. After saving, the capture runs `find_anomalies` for the day and stores the anomalies as findings.

**Output**

```json
{
  "snapshotId": 42, "day": "2026-10-13",
  "window": { "start": "2026-10-13T07:00:00.000Z", "end": "2026-10-14T07:00:00.000Z", "hours": 24 },
  "costSource": "app-optimize",
  "sections": { "cost": "ok", "costSku": "ok", "...": "ok", "incidents": "error" },
  "cost": { "date": "2026-10-13", "total": 18407.85, "currency": "INR", "basis": "list price before credits",
            "topServices": [{ "service": "BigQuery", "cost": 5307.72 }] },
  "findings": { "high": 2, "medium": 16, "low": 20 },
  "anomalies": { "found": 2, "top": [{ "kind": "cost_service", "resource": "BigQuery", "type": "spike", "...": "..." }] },
  "metricsRecorded": 1025,
  "sinceLastSnapshot": { "comparedWith": "2026-10-12", "new": [], "resolved": [], "persisting": 36 },
  "errors": [{ "section": "incidents", "error": "..." }],
  "missingDays": ["2026-10-11"],
  "nextStep": "Capture the missing days too ..."
}
```

It takes 2 to 6 minutes. It runs as a background job like the cost tools (`"status": "running"` → call again with the same arguments). Without Claude, the same capture runs from the terminal: `npm run capture` (see [Local setup](local-setup.md#capture-from-the-terminal)).

### `save_report`

**Inputs:** `title`, `summary` (2-3 sentences), `bodyMarkdown`, `kind` (`daily` default, `weekly`, `monthly`, `incident`, `adhoc`), `date` (default the snapshot's date), `snapshotId`, `findings[]` (`category`, `severity`, `title`, `projectId`, `resource`, `detail`), `tags[]`.

Snapshot findings are already stored; `findings` here is for conclusions: root causes, recommendations, follow-ups.

**Output:** `{ "saved": true, "reportId": 7, "date": "2026-10-15", "findingsSaved": 3 }`

### `list_history`

**Inputs:** `from`, `to`, `type` (`reports` / `snapshots` / `both`), `limit`. Newest first, with summaries and finding counts.

### `get_history`

**Inputs:** `reportId`, or `snapshotId` (id, day or `"latest"`) with optional `section` for the raw stored tool result, or `date` with `type`. With `section`: `limit` (default 50) cuts every list in the result, strings are cut at 1000 characters, the output says what was cut, and a result over 100k characters is refused with a hint; `preset` picks one log preset of the `logs` section. Returns the full report Markdown and its findings, or the snapshot header (section statuses, errors, window) and findings.

### `search_findings`

**Inputs:** `from`, `to`, `projectIds`, `resource` (substring), `category`, `severity[]`, `source` (`snapshot` / `report`), `text` (substring of title or detail), `groupBy` (`fingerprint` default, or `none` for every occurrence), `limit`.

**Output (grouped):** one row per issue with `firstSeen`, `lastSeen`, `daysSeen`, `occurrences`, `openNow`, and the latest wording. `openNow` is `true` (in the latest snapshot), `false` (gone, and its section ran fine on the latest day) or `null` (unknown: its section failed that day, or it's a report conclusion). Open issues first, then unknown, then by severity.

### `get_metric_history`

**Inputs:** `metric`, `kind`, `resource` (substring), `projectIds`, `from`, `to`, `limit`. With no `metric`, lists every recorded kind/metric with its date range.

**Output:** `{ metric, series: [{ kind, projectId, resource, unit, points: [{ date, value }] }] }`.

See the metric kinds table above.

### `find_anomalies`

Statistical anomalies for one day against the days before it, across every stored series.

**Inputs:** `date` (default the latest day captured), `kinds[]`, `projectIds`, `baselineDays` (14), `minPoints` (5 baseline days needed), `zThreshold` (3), `pctThreshold` (25), `limit`.

**Rules:** series are judged on averages and totals (plus `diskPercent.latest`); `.max` and `.latest` copies of the same metric are left out so one change isn't reported three times. A *spike* or *drop* needs |z| ≥ `zThreshold`, |change vs the baseline mean| ≥ `pctThreshold` %, and a change above a noise floor (cost: max(1, 0.5% of the account's mean daily spend, whatever the filters); percentages: 5 points; counts: 3; network 0.5 MiB/s; IOPS 5; connections 2; requests 1/s; latency 20 ms; CPU 0.1 cores; memory 128 MiB; pods/nodes/instances 1; alert minutes 5). *new*: a cost line with no baseline in a kind that has history, or an event count that was 0 every baseline day. *stopped*: a cost line with a baseline and nothing on the day. *missing*: a resource that reported before and nothing on the day, only flagged when the day's section was `ok`. Sparse event counts (alerts per policy, log volume, GKE events and autoscaler decisions) count a day whose section ran fine as 0, so a recovery is a *drop*, not *missing*. Asking for a day that wasn't captured is an error, not an empty result; the output includes the day's section statuses.

**Output:** `{ date, baseline: { from, to, days }, thresholds, seriesChecked, notEnoughHistory, anomalies: [{ kind, projectId, resource, metric, type, value, baselineMean, baselineSd, baselineDays, changePct, z, unit }] }`, strongest first.

### Planned events (sales)

`add_event`, `list_events`, `delete_event`: a calendar of planned events, such as sales, for which capacity is scaled up. Each event has `kind` (default `sale`), `name`, `startDate`, `endDate`, `prepDays` (days before the start when scaling up is expected, default 0) and `cooldownDays` (days after the end allowed for scaling back down, default 1), in history days (the cost source's time zone). `add_event` with `id` updates an event.

How the anomaly checks use it:
- The event window (prep .. cooldown) and the two weeks after it are left out of every baseline, so a sale never becomes "normal". Baselines reach further back to still get 14 normal days.
- On a day in the window, only what an event explains is marked `expected: { event, phase }` (`prep`, `during`, `cooldown`) and skipped as a finding: rises in load, capacity and spend. Errors, alerts, restarts, OOM kills, drops, stopped cost lines and resources that stop reporting are still reported.
- After an event (up to 60 days), a spike carries `notScaledDown` when the event really lifted that series (≥ the % threshold and the noise floor, against the normal days before the event), the day is still at least halfway up, it isn't above what the event itself reached, and it **never came back down** since the event. Days a series is still up after an event are never used as its "normal". The capture stores it as the finding "not scaled down after sale" (high for cost); its recurrence counts the late days.
- Event-style counts (alerts, log volume, GKE events) count quiet days as 0 here too, so an alert that starts during a sale and stays on is caught.

`add_event` with `id` changes only the fields you pass. Adding, changing or deleting an event re-judges the days already captured at once (no Google Cloud calls); `npm run capture -- --recompute-anomalies` does the same for every day.

### `review_event`

How an event went, from the cost history. **Inputs:** `id`, or `date` (the latest event that started on or before it; default today), `baselineDays` (14 normal days before the event), `limit`.

**Output:** `totals` (normal and event cost per day, event cost including prep days, extra cost vs normal), `scaledUpMost` (services and resources the event lifted by at least `pctThreshold` % (default 25) and the noise floor, by extra cost, with `scaledDownOn` and `daysToScaleDown`), `notScaledDown` (still up after the cooldown: the late days and their extra cost, counted until the line is back within half of its lift, up to the next event, the latest day captured, or 60 days), and `previous` / `vsPrevious` for the previous event of the same kind. The baseline is the normal days before the event, leaving out earlier events and the two weeks after them. Default: the latest event that started by the latest day captured.

### `diff_snapshots`

**Inputs:** `from`, `to`: snapshot id, day or `"latest"`. Default: the latest day vs the day captured before it.

**Output:** `findings.new / resolved / notChecked / persisting` (`notChecked`: gone, but its section failed on the later day, so it may still be there), and `metricChanges`: metrics that moved 20% or more between the two days.

### `query_history_sql`

**Inputs:** `sql` (one `SELECT` or `WITH ... SELECT`), `limit` (max 500).

Runs in a child process on its own read-only connection, with SQLite's authorizer allowing only reads (writes, `PRAGMA`, `ATTACH` and schema changes are refused wherever they appear), and is killed after 10 seconds so a runaway query can't freeze the server. Raw results are JSON text: use `json_extract` / `json_each` on `snapshot_results.result_json`. Example: the issues seen on the most days this quarter:

```sql
SELECT title, resource, COUNT(DISTINCT date) AS days FROM findings
WHERE source = 'snapshot' AND date >= '2026-07-01' GROUP BY fingerprint ORDER BY days DESC LIMIT 20
```

---

## Combining tools

| Question | Tools, in order |
|---|---|
| Weekly FinOps report | `get_cost_comparison` → `get_top_cost_resources` → `get_resource_usage` on the movers |
| "Is this expensive thing idle?" | `get_top_cost_resources` → `get_resource_usage` (kind + `names`) |
| Service health report | `get_incidents` → `query_logs` (`errors`, `changes`, `k8s_warnings`) around each incident → `get_gke_health`, `get_cloudsql_health`, `get_vm_health` |
| Post-incident root cause | `get_incidents` → `query_logs` `changes` (what changed before) + `errors` (what broke) with `resourceName` |
| Inventory / cleanup | `list_resources` (`includeInactive: true`) → `get_vm_health` `unattachedDisks` → `get_top_cost_resources` |
| Daily capture (scheduled) | `capture_snapshot` (fills `missingDays` too) |
| Daily FinOps / health reports (scheduled) | `get_history` sections → `find_anomalies` → `search_findings` → `get_metric_history` → `query_logs` with `endTime` → `save_report` ([prompts](scheduled-tasks.md)) |
| "Is this new? Since when?" | `search_findings` (`resource` or `text`) → `get_history` (`snapshotId` + `section`) for that day's detail |
| Monthly report | `list_history` (`type: reports`) → `get_metric_history` (`dailyCost`, `cost_service`) → `search_findings` (`groupBy: fingerprint`) |

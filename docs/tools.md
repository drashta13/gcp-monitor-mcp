# Tools reference

All 12 tools: what each one is for, its inputs, what it returns, and how it works underneath. Every tool is **read-only** (`readOnlyHint: true`) and returns compact JSON as text.

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

## Conventions

These apply to every tool.

**Project scope.** Most tools take `projectIds` (array). If you leave it out, the tool covers every project in `GCP_MONITOR_ALLOWED_PROJECTS`, or every project the service account can see if no allowlist is set. A project outside the allowlist is refused with an error.

**Partial results.** Tools query projects in parallel (up to 4 to 8 at a time). One failing project doesn't fail the call:

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

Calling again with **identical arguments** returns the finished result. Identical calls share one run, and results are cached for 10 minutes. Failures aren't cached.

**Metric summaries.** Wherever a metric appears, it's `{ avg, max, latest }` over the window, from about 48 aligned points. Counters are `{ total }`, and "agent present" is `{ reporting: true }`. A metric with no data is left out.

**Cost data caveats (App Optimize source).** List or contract prices **before** credits and committed-use discounts. At most the last 30 days. Days are in Pacific Time. Data lags usage by up to a day. The BigQuery export source is exact and returns `netCost` (`cost + credits`) and `dataAsOf`.

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

Both windows must fit in the last 30 days (7 + 21 = 28 by default).

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
| `kind` | `vm` \| `gke` \| `cloudsql` \| `cloudrun` \| `uptime` | **required** | |
| `projectIds` | string[] | all allowed | |
| `hours` | 1-1008 | 24 | max 6 weeks |
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
| `hours` | int | 24 (`get_incidents`: 168) |

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

**Per cluster:** `status`, `mode` (autopilot/standard), `versions` (control plane, nodes, release channel), `nodeCount`, `nodePools` (standard: per pool version, status, machine type, autoscaling min/max, auto-upgrade/repair, spot; Autopilot: a summary, because Google manages the pools), `events` (count by reason: `OOMKilling`, `BackOff`, `CrashLoopBackOff`, `Unhealthy`, `FailedScheduling`, `Evicted`, `NodeNotReady`, `FailedMount`, `Killing`), `autoscaling` (`scaleUp`, `scaleDown`, `scaleUpBlocked`), `metrics`, `issues`.

**Flags as issues:** cluster not running or with error conditions, no release channel, node pool version on a different minor than the control plane, auto-repair off (standard), OOM kills, crash loops, scheduling failures, evictions, node-not-ready (unless explained by scale-downs), blocked scale-ups, ≥ 10 container restarts, node CPU ≥ 80%, node memory ≥ 85%.

`Killing` and `Unhealthy` are counted but not flagged: they're normal during rollouts and probes. Use `query_logs` with preset `k8s_warnings` or `oom` and `resourceName: "<cluster>"` to see the individual events, and `get_resource_usage` kind `gke` with breakdown `namespace` for per-workload load.

**How:** GKE API `clusters.list` across all locations, Cloud Logging counts of the `events` log and the `cluster-autoscaler-visibility` log in the window, plus GKE metrics.

### `get_vm_health`

Compute Engine VM state, OS and patches, agents, snapshots and load.

**Per VM:** `status`, `machineType`, `zone`, `lastStart`, `os` (name, version, kernel; needs VM Manager), `patches` (vulnerability counts by severity; needs VM Manager), `agents` (`osConfig`, `opsAgent`), `disks` (per disk: size, type, `lastSnapshot`, `snapshotAgeDays`, `snapshotSchedule`), `metrics`, `issues`.

**Also returns** `unattachedDisks` (disks not attached to any VM, which you pay for unused), and `vmManagerOffIn` with a link if VM Manager is disabled in a project.

**Flags as issues:** not running, a disk with no snapshot schedule and no snapshot in 7 days, OS Config agent not reporting (when VM Manager is on), OS data older than 48 h, Ops Agent not reporting, critical/high vulnerabilities, disk ≥ 85%, memory ≥ 90%, CPU ≥ 85%.

**How:** Compute aggregated `instances`, `disks` and `resourcePolicies` (snapshot schedules) plus `snapshots`. OS Config `inventories` and `vulnerabilityReports` per zone. VM metrics.

### `get_incidents`

What went wrong in the window.

**Output**

| Field | Contents |
|---|---|
| `summary` | `incidents`, `open`, `googleCloudEvents`, `uptimeChecks` |
| `byPolicy` | per alerting policy: `count`, `open`, `totalMinutes`, `severity` |
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

## Combining tools

| Question | Tools, in order |
|---|---|
| Weekly FinOps report | `get_cost_comparison` → `get_top_cost_resources` → `get_resource_usage` on the movers |
| "Is this expensive thing idle?" | `get_top_cost_resources` → `get_resource_usage` (kind + `names`) |
| Service health report | `get_incidents` → `query_logs` (`errors`, `changes`, `k8s_warnings`) around each incident → `get_gke_health`, `get_cloudsql_health`, `get_vm_health` |
| Post-incident root cause | `get_incidents` → `query_logs` `changes` (what changed before) + `errors` (what broke) with `resourceName` |
| Inventory / cleanup | `list_resources` (`includeInactive: true`) → `get_vm_health` `unattachedDisks` → `get_top_cost_resources` |

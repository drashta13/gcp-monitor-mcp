# Changelog

## 0.7.0 (2026-10-15)

Capture everything about each day, find anomalies in the history, and run daily FinOps and Service Health reports on a schedule.

### Added
- `capture_snapshot` covers **one whole day** in the cost source's time zone (`day` input, default 2 days ago) with 14 sections: cost by service, project, SKU, region and resource; the cost comparison; incidents and uptime; Cloud SQL, GKE and VM health; GKE workloads per namespace; Cloud Run; exact warning/error log volume; samples of every `query_logs` preset; and the full inventory. Metrics now include per-cluster GKE events and autoscaler decisions, per-policy alert minutes, and inventory counts.
- One snapshot per day, always covering every configured project. Capturing a day again replaces a section only if the new result is at least as good (`ok` > `partial` > `skipped` > `error`), so a failed section can be retried alone and a failed retry never loses data. The capture result lists `missingDays`: days with no snapshot, nothing usable, or a failed cost section.
- Section status `partial` when some projects, metrics or log presets failed; findings of a section that failed on the later day are `notChecked` (not "resolved"), and `search_findings` reports `openNow: null` for them.
- For a past day, health sections leave out resources created after it and keep the metrics of resources deleted since (`notFoundNow`); every resource's metrics are kept, not only the 200 busiest. Alerts are clipped to the day (`minutesInWindow`, `openAtWindowEnd`) and found by overlap, however long they were open.
- `find_anomalies`: spikes, drops, new and stopped cost lines, and resources that stopped reporting, for any day against the days before it (z-score, % change and noise floors). Sparse event counts (alerts, log volume, GKE events) count quiet days as 0, so recoveries are drops and new error sources are new. Each capture stores its anomalies as findings.
- Sales calendar (`add_event`, `list_events`, `delete_event`, `review_event`): planned events such as sales are kept out of anomaly baselines (with the two weeks after them); rises in load, capacity and spend on their days are marked expected, while errors, alerts, restarts, drops and outages are still reported; capacity the event lifted that never came back down after the cooldown is flagged "not scaled down after sale" for as long as it stays up (up to 60 days) and never becomes the baseline; `review_event` gives an event's cost, scale-up and scale-down timing, late days with their extra cost, and the comparison with the previous one. Adding or changing an event re-judges the stored days at once; updates keep the fields left out. History schema version 3.
- Noise floors for network, IOPS, connections, requests, latency, CPU cores, memory, pod/node counts and alert minutes, so tiny absolute changes aren't reported as anomalies.
- `endTime` on `get_resource_usage`, the health tools, `get_incidents` and `query_logs`, to look at a past window.
- `get_resource_usage` kind `logs`: exact WARNING-or-worse log counts per resource type and severity, from `logging.googleapis.com/log_entry_count`.
- `npm run capture`: capture or backfill days from the terminal (`--day`, `--from/--to`, `--missing`, `--sections`), and `--recompute-anomalies` to redo stored days' anomaly findings without calling Google Cloud.
- [Scheduled tasks](docs/scheduled-tasks.md): the daily capture (12:00 IST) and report (13:00 IST) task prompts, and the Monday 14:30 weekly reports for the previous Sunday–Saturday, written for the client.
- `npm run report-pdf`: turns a Markdown report into a client-ready PDF (styled page printed by headless Chrome, no new dependencies). The weekly reports are delivered as PDFs.

### Changed
- Snapshots are keyed by the day they describe, not the capture date; "latest" and "previous" go by day, so backfilling older days works.
- `capture_snapshot` takes `day` instead of `costDate` and `hours`.
- History schema version 2 (window columns, finding section).

### Security
- `query_history_sql` runs in a child process killed after 10 s, with SQLite's authorizer allowing only reads (the keyword filter could be bypassed, and a runaway recursive query froze the whole server).
- `get_history` section reads are bounded (`limit`, log `preset`, 100k-character cap), so a day's log samples can't flood a session.

### Fixed
- Monitoring series grouped by `resource.type` lost the type.
- Counters (e.g. log entries) sorted as if empty in `get_resource_usage`.
- The Monitoring alignment period now divides 23- and 25-hour days exactly.
- Cost lines that share a key (a resource billed under two services) are added up; Cloud Run services are keyed by region.
- Google Cloud events in a past window must overlap it (an old outage that Google edited later no longer shows up); events with no start or end time count on the day of their last update.
- Google-managed node VMs (GKE Autopilot `gk3-`, standard `gke-`, VPC connector `aet-`) replaced since a past day no longer enter VM history; on Autopilot that was ~200 short-lived "VMs" a month, each later flagged as "stopped reporting".
- App Optimize history is about a year, not 30 days: the cost comparison now works for any day in that range. Days older than Cloud Logging's 30-day retention mark `logs` and `gke` as `partial`.
- Anomalies are judged on averages and totals (plus the latest disk fill), not also on the max and latest copies of each metric.

## 0.6.0 (2026-10-15)

Local history for scheduled daily runs.

### Added
- History database: a local SQLite file (`~/.gcp-monitor-mcp/history.db`, built-in `node:sqlite`, no new dependency) with snapshots, raw results, metrics, findings and reports. `GCP_MONITOR_DB_PATH`, `GCP_MONITOR_HISTORY_DAYS` (default 400) and `GCP_MONITOR_HISTORY=off` configure it.
- `capture_snapshot`: records cost for the last complete day, cost anomalies, incidents and Cloud SQL / GKE / VM health the same way every day, and returns what is new, resolved and persisting since the previous snapshot.
- `save_report`: stores Claude's written report and its conclusions.
- `list_history`, `get_history`, `search_findings` (recurrence: first/last seen, days seen, open now), `get_metric_history` (cost and utilization series beyond App Optimize's 30 days), `diff_snapshots`, `query_history_sql` (read-only).
- Server instructions tell clients when to use the history and to treat stored text as data.
- Docs: daily scheduled-task prompt, history tools reference, security notes for the local database.

### Changed
- Node 22.13 or newer is required (`node:sqlite`); CI runs on Node 22 and 24.

### Fixed
- A non-date string in a date input (e.g. `startDate: "latest"`) threw a RangeError inside validation instead of failing it cleanly.

## 0.5.2 (2026-10-14)

Fixes from the full code review of 0.5.1. No new tools; a few new fields and inputs.

### Security
- Counts keyed by text that comes from Google Cloud (cluster names, event reasons, alert policy names, log fields, vulnerability severities) are built in `Map`s, so a log entry naming a cluster `__proto__` can no longer corrupt every other cluster's result or break the server.
- `projectIds` is validated against the project ID format, deduplicated and capped at 50 per call, everywhere (one shared check). A crafted ID can't change the URL path of a request, and duplicates no longer double-count App Optimize costs.
- The App Optimize `service` filter escapes backslashes as well as quotes and refuses control characters.
- App Optimize reports are deleted even when building or reading them fails, delete failures are logged, and reports left behind by a crash (older than 1 hour) are swept on the first call.
- Background jobs: expired results are evicted, the cache is capped at 100 entries, every REST request has a 60 s timeout, and health/log results are kept for 2 minutes instead of 10.
- Errors are logged as message and code only, never the raw HTTP error object.
- A log name with a broken `%` sequence no longer fails `query_logs`.

### Correctness
- A background job that fails after the caller stopped waiting now reports its error on the next call instead of silently re-running forever.
- The "still running" message names what is running (cost report, VM health, logs...).
- `query_logs` no longer crashes on structured `message`/`error` objects.
- App Optimize `day` values are normalised once, so `get_cost_trend` with `granularity: week` can't throw on timestamp-shaped days; a cost of exactly 0 is kept as a number.
- `get_cost_comparison` refuses to add costs in different currencies, and anomaly flags are decided on exact per-day values (a resource at 0.004/day is no longer "stopped").
- Default cost dates are "today" in the cost source's time zone (Pacific for App Optimize).
- `pacificMidnight` is correct on daylight-saving switch days.
- `get_vm_health` skips GKE node VMs by default (`includeGkeNodes: true` to include them) and, like `get_cloudsql_health`, takes `limit` and reports `truncated`.
- Lists that stop at an internal cap now say so: `rowsTruncatedIn` (App Optimize), `truncatedProjects` (inventory), `listTruncatedIn` (VM health), `alertsTruncatedIn` (incidents), `truncated` (`list_projects`). `get_incidents` also asks the API for open-or-recent alerts, so an alert still open from long ago is no longer lost behind newer ones.
- `get_resource_usage` reports metrics the API rejected in `metricErrors` instead of dropping them; the health tools pass it through. `get_cloudsql_health` reports instances it couldn't read in `instanceErrors`.
- Snapshot timestamps are compared as instants, not strings.
- 2nd-gen Cloud Functions are no longer also counted as Cloud Run services in `list_resources`.
- `query_logs` `truncated` is only set when entries were left out.
- The Kubernetes `Killing` event (Normal, fires on every pod stop) no longer eats the GKE event budget.
- The Logging `entries:list` POST is retried on 429/503 like the GET calls.
- An unexpected unhandled promise rejection now logs its stack and exits (so the client restarts the server) instead of leaving a half-broken process; credential errors are still just logged.
- Health tools on a server without health services fail with a clear message, and impossible dates such as `2026-02-31` are refused up front.

### Housekeeping
- `ConfigError` lives in `src/gcp/errors.js`; one `round` helper; one `addDays`; version read from `package.json`; thresholds in a `THRESHOLDS` object per health module; `src/index.js` is executable.
- CI on Node 20/22/24, Prettier and EditorConfig files, `.nvmrc`, coverage script, this changelog.
- 31 new tests (`rest`, `backgroundJob`, `loadConfig`, project scope, prototype pollution, log edge cases, DST, filter escaping, report cleanup, GKE nodes, alert filter, metric errors...).

## 0.5.1

12 tools covering cost (with week-over-baseline anomalies), inventory, usage metrics and service health (Cloud SQL, GKE, VMs, incidents, logs).

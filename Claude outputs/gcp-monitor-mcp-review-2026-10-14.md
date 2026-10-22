# gcp-monitor-mcp — full review (v0.5.1, commit 87dd59b, 2026-10-14)

Method: every file under `src/`, `test/`, `docs/` and the package manifests was read in full. Three independent reviewers covered security, correctness/robustness, and tests/docs; the findings below were de-duplicated and the headline security items were reproduced with Node. `npm test` was run on the dev machine (Node 22.23.2): **42/42 pass in 2.6 s**, fully offline. `npm audit --omit=dev`: **0 vulnerabilities**. Lockfile: 179 packages, all from registry.npmjs.org with integrity hashes; the only install script is protobufjs's standard postinstall.

Overall verdict: this is a well-built, security-conscious codebase. The architecture (read-only identity, allowlist enforced before any API call, parameterised BigQuery, static Monitoring filters, stdio only, no key handling, honest security doc) is the right one. There are **no critical or high-severity security holes**. What follows are real but bounded issues, a couple of genuine correctness bugs that will bite in production, and hygiene gaps.

---

## 1. Security findings

### S1 · Medium — Prototype pollution from attacker-writable log text
`src/gcp/gkehealth.js:94-99`, `src/gcp/incidents.js:67-79` (also lower-impact single-level cases: `logs.js:117-120 countBy`, `vmhealth.js:225 vulnCounts`, `inventory.js:83`)

```js
const byCluster = {};
byCluster[cluster] ??= {};            // cluster = resource.labels.cluster_name from a log entry
byCluster[cluster][kind] = (byCluster[cluster][kind] ?? 0) + 1;   // kind = jsonPayload.reason
```
Anyone who can write a log entry into a monitored project (a compromised pod using the node SA's Log Writer role is enough) can set `cluster_name="__proto__"` and `reason="OOMKilling"`. `byCluster["__proto__"]` resolves to `Object.prototype`, `??=` skips, and the next line writes `Object.prototype.OOMKilling = 1`. **Reproduced**: every other cluster in the result then reports an OOM kill it never had; with `cluster_name="constructor", reason="keys"`, `Object.keys` itself gets clobbered and the server is broken until restart. `incidents.js` has the same pattern keyed on the alert policy `displayName`.

Fix: use `new Map()` or `Object.create(null)` for every object keyed by text that comes back from Google. `comparison.js`, `metrics.js` and `vmhealth.js:212` already use `Map` — make it the rule.

### S2 · Medium — `projectIds` is not deduplicated, bounded or format-checked
`src/server.js:15` (`z.array(z.string())`), `src/gcp/util.js:23-31`, `src/gcp/billing.js:54-59`, `src/gcp/appoptimize.js:46-52`

All three allowlist checks use `includes`, so `["p","p"]` passes. On the App Optimize source each id runs its own report and rows are concatenated, so duplicated ids return exactly 2× the real spend in `get_cost_summary`/`trend`/`top`/`comparison`. Health tools list every VM/instance once per duplicate. With no allowlist, a 10 000-element array drives thousands of authenticated API calls. BigQuery (`IN UNNEST`) and `metrics.js` (Map keyed by project) are immune to the double counting but not the fan-out.

Fix: `projectIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)).max(50).optional()` in `server.js`, and `[...new Set(projectIds)]` inside a single shared scope function (see S5/Q1).

### S3 · Low — Unvalidated project id reaches REST URL paths (only without an allowlist)
`src/gcp/vmhealth.js:28,44-53`, `sqlhealth.js:11`, `gkehealth.js:27`, `incidents.js:16,27`

`projects/${projectId}` is string-built. With `GCP_MONITOR_ALLOWED_PROJECTS` set, exact-match `includes` closes this. Without it, **reproduced**: `projectId="../../x?y=1#"` normalises to `https://compute.googleapis.com/compute/x?y=1`, letting the model aim an authenticated GET at any path on that host. Impact is small (GET only, same host, IAM still applies, response shapes won't parse) but it's cheap to close with the regex from S2 applied in `createProjectScope`'s no-allowlist branch too, plus `encodeURIComponent` at the URL sites.

### S4 · Low — Backslash escape in the App Optimize `service` filter
`src/gcp/appoptimize.js:104`

`service.replaceAll("'", "\\'")` escapes quotes but not backslashes. **Reproduced**: `x\' || true || '` becomes `product_display_name == 'x\\' || true || ''` — the string closes after a literal backslash and `|| true` is injected; since `&&` binds tighter, the date bounds are dropped. Scope stays on the one project, so this is wrong numbers / bigger reports, not data access. Fix: escape `\` before `'`, reject control characters, or drop the server-side filter and filter rows client-side on `product_display_name`.

### S5 · Low — App Optimize reports can leak and are readable by home-project Viewers
`src/gcp/appoptimize.js:109-136`

`deleteReport` sits in a `finally` that only wraps the read loop. If `operation.promise()` rejects, or the MCP client kills the process while a long report runs in the background (the "running" design makes this likely), the report is never deleted, and delete failures are swallowed. Per `docs/gcp-setup.md`, `appoptimize.reports.getData` is in `roles/viewer` on the home project, so a Viewer there can read cost rows for every allowed project for as long as a stale report exists. Fix: generate the report id yourself, wrap create+poll+read in one `try/finally` that deletes by that id, log delete failures to stderr, and sweep `mcp-*` reports older than ~1 h on startup.

### S6 · Low — `backgroundJob` cache is unbounded and the 10-minute TTL is wrong for logs/health
`src/server.js:335-366`, `src/gcp/rest.js:12`

Entries are only replaced when the *same* key is re-requested; distinct argument sets accumulate for the process lifetime, each holding a full result. `rest.js` sets `retry: true` but no `timeout`, so a hung request pins a "running" entry forever. Separately, `query_logs` and `get_incidents` with `hours: 1` are cached 10 minutes although `since` is computed at run time — "any new errors?" asked twice in 10 minutes silently returns stale data. Fix: sweep expired entries on each call, cap the Map (LRU ~100), add `timeout: 60_000` to `rest.request`, and give health/log jobs a short or zero `cacheMs`.

### S7 · Low — REST client requests full `cloud-platform` scope for read-only work
`src/gcp/rest.js:11`. Every `rest.*` call is a read. Requesting `https://www.googleapis.com/auth/cloud-platform.read-only` would make the REST path unable to mutate even when someone runs as themselves (security.md §2 warns this is common). Only `AppOptimizeClient` needs write.

### S8 · Low — `decodeURIComponent` on a remote-controlled log name can throw
`src/gcp/logs.js:89`. A malformed `%` sequence throws `URIError` and fails the whole `query_logs` call for that project. Wrap in try/catch.

### S9 · Low — stderr error logging relies on gaxios redaction
`src/server.js:378` does `console.error(err)` with the full error object. For raw gaxios errors (thrown when the body has no `error` field, `rest.js:43`) this includes `config.headers`. Installed gaxios 7.3.1 does have `errorRedactor` enabled by default, so `Authorization` is blanked today — but it's an implicit dependency on a library default. Log `err.message` + `err.code` only.

### Security: confirmed good
- BigQuery: table name regex-validated at config time; everything else is bound parameters with explicit types; `maximumBytesBilled` on every query; `GROUP_BY`/`GRANULARITY` whitelisted via `z.enum`. Injection-free.
- Monitoring filters are fully static; `names` filtering is client-side everywhere, never interpolated. Asset Inventory uses whitelisted `assetTypes` and no free-text query.
- Logging: project scope is enforced through `resourceNames`, outside the user-controlled filter. A crafted `filter` can escape its parentheses and override the *preset*, but cannot drop the `timestamp>=` term (OR binds tighter than AND) — and the caller already controls `hours` and `preset`, so no privilege gain. `resourceName` quote-stripping is sufficient; add backslash escaping for tidiness.
- Allowlist is checked before any API call on every path that accepts `projectIds`, including both cost backends and `list_projects`.
- docs/security.md's claim holds: `describe()` in vmhealth/gkehealth/sqlhealth drop `metadata` (startup scripts), `networkInterfaces` (IPs), `serviceAccounts`, `masterAuth`, `endpoint`, `ipAddresses`, `serverCaCert`. Full objects are fetched into memory but nothing persists them.
- Only two non-GET calls exist (report create/delete; `entries:list` POST, a read). Tool annotations are `readOnlyHint: true`. stdout is reserved for MCP. No stack traces reach the model. ADC only, no token logging.
- Supply chain is clean; every dependency is imported and nothing undeclared is imported.
- Prompt-injection surface is documented honestly (§6/§7). Log messages and Service Health descriptions are truncated to 500 chars. One undocumented field: `get_incidents` returns alert resource `labels` wholesale.

---

## 2. Correctness and robustness

### C1 · High — `containerRestarts` likely never returns data, and the failure is invisible
`src/gcp/metrics.js:52`: `kubernetes.io/container/restart_count` is a GAUGE metric and `ALIGN_DELTA` is documented for CUMULATIVE/DELTA kinds. If the API rejects it (INVALID_ARGUMENT), the error doesn't match the "cannot find metric" regex in `query()` and `usage()` line 171 drops rejected metrics silently — so the "≥ 10 restarts" GKE issue can never fire and nothing tells the caller. The fake Monitoring client in tests can't catch this. **Verify against a real project** (call `get_resource_usage kind=gke hours=1` and look for `containerRestarts`); if absent, switch to `ALIGN_MAX` + a client-side `last − first` stat. Regardless of outcome: surface per-metric failures in a `metricErrors` field instead of discarding them (this also covers `sqlhealth.js:22,34`, where a per-instance error object is built and then filtered out, so the instance just vanishes).

### C2 · High — A job that outlives `waitMs` and then fails can never report its error
`src/server.js:345-348`. Caller 1 gets `running` at 45 s; the job fails at 60 s and the entry is deleted; the retry finds no entry and starts the job again. For a deterministic failure (bad filter, permission, bytes-billed cap) the model loops `running → re-run → running` and never sees the error, re-running the expensive query each time. Fix: on rejection keep `{ error, doneAt }` for a short TTL and rethrow it once on the next call for that key.

### C3 · Medium — The "running" message says "cost report" for logs and health tools
`src/server.js:355-361` is hard-coded; `backgroundJob` also wraps the five health/log tools (`:155-160`). Pass a label.

### C4 · Medium — Structured `jsonPayload.message` / `error` objects crash `query_logs`
`src/gcp/logs.js:101-102, 91`: `message(e)?.slice(...)` throws `TypeError` when `message` or `error` is an object (very common in structured logs), failing the whole call. Stringify non-strings before slicing.

### C5 · Medium — App Optimize `trend` and `comparison` disagree on the `day` format
`appoptimize.js:166, 223, 317-325`: `comparison` defensively does `String(r.day).slice(0,10)` (implying a timestamp comes back), but `trend` passes `r.day` straight into `bucket()`; with a timestamp, `granularity: 'week'` builds an Invalid Date and throws `RangeError`. Normalise once in `toObject`.

### C6 · Medium — Silent truncation at `MAX_ROWS` corrupts totals
`appoptimize.js:25,131` stops paging at 50 000 rows per project with no `truncated` flag; `sku`/`region` group-bys on a busy project can exceed that, under-reporting totals and comparison baselines with no indication. Same pattern, lower stakes: `inventory.js` (`MAX_PER_PROJECT`), `vmhealth.js:19` (10 000), `projects.js` (`MAX_PROJECTS`), `incidents.js` alerts at 500 (an OPEN alert older than the newest 500 is lost — add a server-side filter).

### C7 · Medium — `get_vm_health` reports every GKE node as a sick VM, with no `limit`
`vmhealth.js:82-100,170-180`: `aggregated/instances` includes GKE node VMs; each has no snapshot schedule, no OS Config inventory, no Ops Agent, so every node gets three issues and sorts to the top. Skip instances labelled `goog-gke-node` (or add `includeGkeNodes: false`), and add `limit`/`truncated` like every other list tool. `get_cloudsql_health` also lacks `limit`.

### C8 · Medium — `unhandledRejection` handler hides real crashes
`src/index.js:22` logs only `err.message` and continues, turning any forgotten `await` into a silent inconsistency. Log `err.stack`; swallow only the credential patterns the comment describes, otherwise exit so the client restarts the server.

### C9 · Medium — `pacificMidnight` is off by one hour on DST-transition days
`appoptimize.js:333-339` samples the offset at 12:00 UTC, which is after the 02:00 local switch, so 2026-03-08 and the November date start the filter an hour off.

### Low
- **L1** `rest.js:12` — gaxios `retry: true` retries only GET/PUT/HEAD/OPTIONS/DELETE; the Logging `entries:list` POST (most likely to 429/503) never retries. Add `retryConfig.httpMethodsToRetry` including POST.
- **L2** `rest.js:44` — `toError` discards the original (`cause`, `response.status`).
- **L3** `util.js:10` — `mapLimit` isn't safe against a synchronous throw from `fn`; use `Promise.resolve().then(() => fn(x))`.
- **L4** `comparison.js:36-38,109` — resources are summed across currencies; `currency` is just the first row's. Group by currency or throw for mixed.
- **L5** `appoptimize.js:265` — `if (out.cost)` skips `money()` when cost is numeric `0`, so `cost.amount` is `undefined` and comparison sums go `NaN`. Use `!= null`.
- **L6** `gkehealth.js:16` — `Killing` is a *Normal* event on every pod termination; on a busy cluster it eats most of the 1000-entry budget and makes every other count a lower bound. Drop it or add `jsonPayload.type="Warning"`.
- **L7** `comparison.js:148-151` — flags compare rounded per-day values, so `0.004/day` reads as `stopped`.
- **L8** `vmhealth.js:216` — Compute RFC 3339 timestamps compared as strings; offsets differ across DST so lexical ≠ chronological.
- **L9** `server.js:325` vs `appoptimize.js:28` — default dates are UTC "today" but App Optimize days are Pacific; between 17:00–24:00 PT the default `endDate` is tomorrow.
- **L10** `inventory.js:10-13` — gen-2 Cloud Functions are Cloud Run services and get counted twice.
- **L11** `server.js:37` — `health = {}` default means a health tool on a test server throws `Cannot read properties of undefined`; fail at registration with a `ConfigError`.
- **L12** `isoDate` is shape-only: `2026-02-31` passes and later throws `RangeError: Invalid time value` as an opaque error.
- **L13** `metrics.js:197` — the two `connections` metric types collapse to the last one in the echoed `metrics` map.
- **L14** `logs.js:64` — `truncated` is a false positive when exactly `limit` entries exist.

---

## 3. Code quality and maintainability

- **Q1 Three allowlist implementations** (`util.js:22-32`, `billing.js:54-59`, `appoptimize.js:46-52`) with three different no-allowlist fallbacks (all visible projects / "every project in the table" / `[reportProject]`). Behaviourally consistent today, but S2/S3 fixes must be applied three times and docs/tools.md:24 already describes the fallback wrongly for App Optimize. Extract one `checkAllowed()` in util.
- **Q2 Four `round` helpers** with different null semantics (`billing.js:29` → `0`/`NaN`; `util.js:59` and `comparison.js:4` → `null`; `appoptimize.js:347`). Use one.
- **Q3 `addDays` duplicated** — `appoptimize.js:4` imports it as `shiftDays` *and* redefines it at line 341.
- **Q4 Layering** — `util.js:1` imports `ConfigError` from `billing.js`, so every module transitively loads `@google-cloud/bigquery`. Move it to `src/gcp/errors.js`.
- **Q5 `perProject` reimplemented** in `appoptimize.js:68-75` without `isApiDisabled` classification.
- **Q6 Version string** hard-coded in `server.js:50`, README, overview.md as well as `package.json`. Read it from `package.json`.
- **Q7 bin entry is not executable** — `git ls-files -s src/index.js` → `100644`. `npm link` / global install will produce a non-runnable binary. `git update-index --chmod=+x src/index.js`.
- **Q8 Magic numbers** — thresholds (36 h / 7 d / 48 h / 85 / 80 / 90 / 10 restarts) and concurrency (2/4/8) scattered across the three `describe()` functions; a `THRESHOLDS` object per module would make them discoverable and testable.
- **Q9** `projects.js:25` passes `{ autoPaginate: false }` to the `*Async` iterator, which ignores it. `index.js:48` prints `billing export (not set)` when nothing is configured.
- **Q10 MCP descriptions** — health tool descriptions don't mention the `running`/retry behaviour that tools.md promises; `get_cost_comparison` doesn't say it's App Optimize-only (and `comparison.js` is source-agnostic, so a BigQuery implementation is a straightforward gap).

---

## 4. Tests

42 tests, all offline and deterministic in inputs, with fakes that record calls so assertions check the **exact** SQL/params/report filters/Monitoring aggregations sent to Google. Strong `deepEqual` on full `issues` arrays. No vacuous tests.

**Untested modules**: `src/gcp/rest.js` (pagination, `truncated`, POST pageToken-in-body, `toError`) and `src/gcp/projects.js` — nothing at all. **Untested behaviours that matter**: `loadConfig` bad `GCP_BQ_MAX_BYTES_BILLED`; `createProjectScope` denial message / subset / no-allowlist fallback; `resourceName` quote stripping (the injection-relevant branch); `backgroundJob` cache expiry and concurrent same-args (the `now` injection point exists but is never used); `billing` `types` option and `topResources` SQL; VM-Manager-off detection from the API error; Service Health dedupe; `names`/`limit`/`truncated` on most tools; `explain()` branches for `SERVICE_DISABLED`, 403, `Not found: Table`.

**Fake weaknesses**: `fakeRest.list` (`health.test.js:229-233`) hard-codes `truncated:false`, so every "counts are lower bounds" path is unreachable; health tests throw pre-shaped `Error('403 PERMISSION_DENIED')` but nothing proves `toError` produces that shape. `comparison.test.js:595` depends on the wall clock because `server.js:150` never passes `now` into `billing.comparison`.

**Highest-value tests to add** (each one-liner is the assertion):
1. `rest.list` pages until `max`, sets `truncated`, puts `pageToken` in the POST body.
2. `rest.request` maps a Google error body (`code 403`) and `explain()` yields the Permission-denied text; client is reset after failure.
3. `backgroundJob`: concurrent identical calls run `fn` once; distinct args run separately; advancing injected `now` past `cacheMs` re-runs; a failure after `waitMs` is reported on the next call (this will fail until C2 is fixed).
4. `loadConfig` rejects `0`, `-5`, `abc`, `1.5` for bytes billed; derives `billingQueryProject` from the table.
5. `createProjectScope` names only the denied ids; subset returns the request; no-allowlist falls back to `projects.list()`; duplicates are collapsed (fails until S2).
6. `query_logs` strips quotes from `resourceName`, merges across projects, honours `limit`, `truncated`, `pageSize`; a `__proto__` cluster name in gkehealth leaves `Object.prototype` untouched (fails until S1).
7. `billing`: `types` passed, `service` bound, `topResources` SQL on a detailed export, `comparison` refuses.
8. `vmhealth`: OS Config "has been disabled" → `vmManagerOffIn`, other errors → `osConfigError`.
9. `incidents`: Service Health events dedupe across projects; ACTIVE events outside the window are kept.
10. `get_resource_usage`: `names` filter, `limit`/`truncated`, uptime worst-first, long-window alignment.

---

## 5. Documentation

Unusually accurate. All 12 tool names, enums, min/max and defaults in `docs/tools.md` match `server.js`; env vars match `config.js`; all internal links and anchors resolve (checked mechanically); App Optimize role names and permissions were verified against Google's access-control page. Specific corrections:

- `docs/tools.md:272-276` documents health `hours` as "default 24" with no max, but the maxima differ: SQL/VM/incidents 1008, GKE 720, logs 720 — likely unintended in code too.
- `docs/tools.md:24` ("no allowlist → every project the SA can see") is wrong for App Optimize cost tools, which scope to `[reportProject]` only (`appoptimize.js:51`).
- `README.md:26` says cost dates are UTC; `tools.md:47,128` and the code say App Optimize days are Pacific. Contradiction — README is right only for the BigQuery source.
- `docs/tools.md:26` "4 to 8 at a time": metrics fan out over projects 2 at a time (`metrics.js:503`).
- `docs/gcp-setup.md:189` "each tool call creates a short-lived report" → one **per project in scope**.
- `docs/gcp-setup.md:244-247` lists `roles/appoptimize.viewer` as a narrower role while keeping Admin, which already includes it.
- `docs/security.md:97` says `.env` is "already in .gitignore" as a place for secrets — nothing loads `.env` (no dotenv). Misleading.
- `docs/security.md:111` omits that the BigQuery path creates (billed, byte-capped) query jobs; `:80` "its identity can't change anything" is slightly overstated given `appoptimize.admin`.
- `security.md` says install with `npm ci`; README, local-setup and claude-setup say `npm install`. Lockfile exists, so `npm ci` is right everywhere.
- `local-setup.md` clone URL is an `<owner>` placeholder; README has no clone step at all.
- The `roles/viewer` claims for `osconfig.inventories.list`, `servicehealth.events.list`, `monitoring.alerts.list`, etc. could not be verified offline. Add the reproducible check to gcp-setup.md: `gcloud iam roles describe roles/viewer --format=json | grep -E 'osconfig.inventories.list|servicehealth.events.list|monitoring.alerts.list'`.

---

## 6. Repo hygiene

No `LICENSE` (README says "not yet chosen"; `package.json` is `UNLICENSED`/`private` — consistent, decide before sharing). No `CHANGELOG` despite v0.5.1. No `CONTRIBUTING` (overview.md partly covers it). **No CI** — the suite is fast and offline, so a `node --test` workflow on Node 20/22/24 is cheap. No `.prettierrc`/ESLint/`.editorconfig` although the code is clearly Prettier-formatted (120 cols, single quotes). `engines.node >=20` not enforced (no `.npmrc engine-strict`, no `.nvmrc`). `.gitignore` is 4 lines (missing `coverage/`, `.env.*`, editor dirs). No coverage reporting (`node --test --experimental-test-coverage` works out of the box). Six dependencies have minor updates available (`npm outdated`), none security-relevant.

---

## 7. Recommended order of work

1. **S1** prototype pollution → `Map`/`Object.create(null)` everywhere remote text is a key. Small change, real impact.
2. **C2** failed-after-timeout jobs never report; **C3** wrong "cost report" message. Both in `backgroundJob`; fix together with **S6** eviction/TTL and a `rest` timeout.
3. **S2 + S3 + Q1** — one shared `checkAllowed()` with regex, dedupe and `.max(50)`.
4. **C1** verify `containerRestarts` against a real cluster; add `metricErrors`/`instanceErrors` reporting (also fixes the sqlhealth silent drop).
5. **C4, C5, L5** — the three crashes/NaN paths in logs and App Optimize.
6. **S4, S5** — App Optimize filter escaping and report cleanup.
7. **C7** GKE nodes in VM health + `limit`; **C6** `truncated` flags on paging caps.
8. **Q7** exec bit, **Q6** version from package.json, **C8** narrow the unhandledRejection handler.
9. Tests 1–6 above, then CI + Prettier config + `.nvmrc`.
10. Doc corrections in §5.

## 8. What's done well

Server-side aggregation in Monitoring keeps `get_resource_usage` to one series per resource with well-chosen aligners. The comparison/anomaly design (per-day normalisation, noise floor, spike detection, job folding) is thoughtful, pure and unit-tested. Partial-failure reporting (`failedProjects`, `apiNotEnabledIn`, `vmManagerOffIn` with a doc link) is consistent and explained to the LLM caller. `explain()` turns the usual GCP failure modes into actionable text with the exact `gcloud` command or IAM role. The background-job pattern is the right answer to MCP's ~60 s client timeout. Every service takes an injected client and `now`, which is why the test suite is fast, offline and precise — and why the gaps above are easy to close. `docs/security.md` is unusually honest about residual risk.

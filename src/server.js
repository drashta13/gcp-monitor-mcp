import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GROUP_BY, GRANULARITY } from './gcp/billing.js';
import { ConfigError } from './gcp/errors.js';
import { KINDS, DEFAULT_KINDS } from './gcp/inventory.js';
import { USAGE } from './gcp/metrics.js';
import { PRESETS } from './gcp/logs.js';
import { PROJECT_ID_RE, dateIn } from './gcp/util.js';
import { registerHistoryTools, HISTORY_INSTRUCTIONS } from './history/tools.js';

const { version: VERSION } = createRequire(import.meta.url)('../package.json');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

// Shape and validity: "2026-02-31" has the right shape but is not a date.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  // zod runs refinements even when the regex failed, so a non-date string must not throw here.
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  }, 'Not a real calendar date');

const MAX_PROJECTS_PER_CALL = 50;

const projectIds = z
  .array(z.string().regex(PROJECT_ID_RE, 'Not a valid Google Cloud project ID'))
  .max(MAX_PROJECTS_PER_CALL)
  .optional()
  .describe('Limit to these project IDs. Default: all configured projects.');

const costFilters = {
  startDate: isoDate.optional().describe('Inclusive start date, YYYY-MM-DD. Default: first day of the current month.'),
  endDate: isoDate.optional().describe('Inclusive end date, YYYY-MM-DD. Default: today.'),
  projectIds,
  service: z
    .string()
    .max(200)
    .optional()
    .describe('Limit to one service by its billing name, e.g. "Compute Engine", "Cloud Run", "BigQuery".'),
};

const COST_NOTE =
  'Data comes from the Cloud Billing export to BigQuery, which lags real usage by a few hours to about a day; ' +
  'dataAsOf says how fresh it is. netCost = cost + credits (credits are negative). Amounts are in the billing account currency.';

const RUNNING_NOTE = 'If a result has status "running", call again with exactly the same arguments after ~30s.';

// Cost reports take 15-60s+ to build in Google Cloud, and MCP clients give up on a tool call after about 60s.
// So a slow call waits up to WAIT_MS; if the work isn't done, it returns a "still running" note while the
// work continues in the background, and the next call with the same arguments picks up the result.
const WAIT_MS = 45_000;
const CACHE_MS = 10 * 60_000; // cost data updates about daily; repeat questions in a chat are free
// Health and log results are "as of now", so keep them only long enough for the retry to pick them up.
const HEALTH_CACHE_MS = 2 * 60_000;

export function createServer({
  projects,
  billing,
  inventory,
  usage,
  health = {},
  history = null,
  waitMs = WAIT_MS,
  cacheMs = CACHE_MS,
  healthCacheMs = HEALTH_CACHE_MS,
}) {
  const job = (fn, what) => backgroundJob(fn, { waitMs, cacheMs, what });
  const costSummary = job((args) => billing.summary(args));
  const costTrend = job((args) => billing.trend(args));
  const costTop = job((args) => billing.topResources(args));
  const costComparison = job((args) => billing.comparison(args));
  const dates = (args) => withDates(args, new Date(), billing.timezone);

  const costNote = `${billing.note ?? COST_NOTE} Reports can take a minute: ${RUNNING_NOTE}`;
  const server = new McpServer(
    { name: 'gcp-monitor-mcp', version: VERSION },
    history ? { instructions: HISTORY_INSTRUCTIONS } : {},
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List GCP projects',
      description:
        'List the active Google Cloud projects this server can read. Use it to discover project IDs before ' +
        'asking for project-specific data.',
      annotations: READ_ONLY,
    },
    handler(async () => {
      const { projects: list, truncated } = projects.search
        ? await projects.search()
        : { projects: await projects.list(), truncated: false };
      return { count: list.length, ...(truncated ? { truncated: true } : {}), projects: list };
    }),
  );

  server.registerTool(
    'get_cost_summary',
    {
      title: 'Cost summary',
      description:
        'Total Google Cloud spend for a date range, broken down by service, project, SKU or region and sorted by ' +
        `highest cost first. Covers every project on the billing account in one call. ${costNote}`,
      inputSchema: {
        ...costFilters,
        groupBy: z.enum(Object.keys(GROUP_BY)).default('service').describe('Dimension to break cost down by.'),
        limit: z.number().int().min(1).max(100).default(25).describe('Max rows to return.'),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => costSummary(dates(args))),
  );

  server.registerTool(
    'get_cost_trend',
    {
      title: 'Cost trend',
      description:
        'Net Google Cloud spend over time as a series of daily, weekly or monthly points. Use it to spot spikes ' +
        `or compare periods. ${costNote}`,
      inputSchema: {
        ...costFilters,
        granularity: z.enum(Object.keys(GRANULARITY)).default('day'),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => costTrend(dates(args))),
  );

  server.registerTool(
    'get_top_cost_resources',
    {
      title: 'Most expensive resources',
      description:
        'The individual resources (VMs, buckets, Cloud Run services, databases...) that cost the most in a date ' +
        `range. With the BigQuery source this needs the Detailed usage cost export. ${costNote}`,
      inputSchema: {
        ...costFilters,
        limit: z.number().int().min(1).max(100).default(20).describe('Max resources to return.'),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => costTop(dates(args))),
  );

  server.registerTool(
    'get_cost_comparison',
    {
      title: 'Cost comparison and anomalies',
      description:
        'Week-over-baseline cost comparison for FinOps reports: spend per day in the current period vs the period ' +
        'before it, by service and by resource, with % change and anomalies flagged (increase / decrease past the ' +
        'threshold, new spend, stopped spend, and spike days far above the baseline range). Default: the 7 days ' +
        'ending 2 days ago vs the 21 days before. Everything is per day, so windows of different lengths compare ' +
        'fairly. Both windows must fit in App Optimize\'s history (about the last year). Available on the App Optimize cost source only ' +
        `(GCP_COST_REPORT_PROJECT), not on the BigQuery export. ${costNote}`,
      inputSchema: {
        days: z.number().int().min(1).max(14).default(7).describe('Length of the current period in days.'),
        baselineDays: z.number().int().min(3).max(28).default(21).describe('Length of the baseline before it.'),
        endDate: isoDate
          .optional()
          .describe('Last day of the current period, YYYY-MM-DD. Default: 2 days ago (the last complete day).'),
        threshold: z
          .number()
          .min(5)
          .max(1000)
          .default(25)
          .describe('Per-day % change that counts as an increase or decrease.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(15)
          .describe('Max rows per list (anomalies, services, resources).'),
        projectIds,
        service: costFilters.service,
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => costComparison(args)),
  );

  const healthWindow = (def, max) =>
    z.number().int().min(1).max(max).default(def).describe(`Look-back window in hours (max ${max}).`);
  const endTime = z.iso
    .datetime({ offset: true })
    .optional()
    .describe('End of the window, ISO 8601 (e.g. "2026-10-14T00:00:00-07:00"). Default: now. Use it to look at a past period.');
  const listLimit = (def, max) => z.number().int().min(1).max(max).default(def).describe('Max rows to return.');
  // Health services are optional for a test server, but a call must fail with a clear message, not a TypeError.
  const service = (name) => {
    if (!health[name]) throw new ConfigError(`The ${name} health service is not configured on this server`);
    return health[name];
  };
  const healthJob = (fn, what) => backgroundJob(fn, { waitMs, cacheMs: healthCacheMs, what });
  const sqlHealth = healthJob((a) => service('cloudsql').health(a), 'collecting Cloud SQL health');
  const gkeHealth = healthJob((a) => service('gke').health(a), 'collecting GKE health');
  const vmHealth = healthJob((a) => service('vm').health(a), 'collecting VM health');
  const incidents = healthJob((a) => service('incidents').incidents(a), 'collecting incidents');
  const logs = healthJob((a) => service('logs').query(a), 'searching logs');
  const healthNote = `Can take a minute on large projects: ${RUNNING_NOTE}`;

  server.registerTool(
    'get_cloudsql_health',
    {
      title: 'Cloud SQL health',
      description:
        'Health of every Cloud SQL instance: state, high availability / failover setup, automated backups, ' +
        'point-in-time recovery, last successful and failed backup runs, storage auto-resize, deletion protection, ' +
        'maintenance window and scheduled maintenance, plus uptime %, CPU, memory, disk %, connections and IOPS over ' +
        `the window. Each instance has an issues list; instances with the most issues come first. ${healthNote}`,
      inputSchema: {
        projectIds,
        names: z.array(z.string()).optional().describe('Only these instance names.'),
        hours: healthWindow(24, 24 * 42),
        endTime,
        limit: listLimit(100, 500),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => sqlHealth(args)),
  );

  server.registerTool(
    'get_gke_health',
    {
      title: 'GKE cluster health',
      description:
        'Health of every GKE cluster: status, control plane and node versions, release channel, node pools ' +
        '(version skew, autoscaling min/max, auto-upgrade/repair, spot), Kubernetes warning events (OOM kills, ' +
        'crash loops, scheduling failures, evictions, node not ready), cluster autoscaler scale-ups/downs and ' +
        'blocked scale-ups, plus restarts, pods, nodes and node CPU/memory % over the window. Use ' +
        `get_resource_usage kind "gke" with breakdown "namespace" for per-workload detail. ${healthNote}`,
      inputSchema: {
        projectIds,
        names: z.array(z.string()).optional().describe('Only these cluster names.'),
        hours: healthWindow(24, 24 * 30),
        endTime,
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => gkeHealth(args)),
  );

  server.registerTool(
    'get_vm_health',
    {
      title: 'VM health',
      description:
        'Health of every Compute Engine VM: status, machine type, OS and version, OS patch status (vulnerability ' +
        'counts by severity), OS Config and Ops Agent health, disk snapshot coverage (last snapshot, schedules), ' +
        'plus CPU, memory and fullest-disk % over the window. Also lists unattached disks. GKE node VMs are left ' +
        `out by default: get_gke_health covers them. ${healthNote}`,
      inputSchema: {
        projectIds,
        names: z.array(z.string()).optional().describe('Only these VM names.'),
        hours: healthWindow(24, 24 * 42),
        endTime,
        includeGkeNodes: z.boolean().default(false).describe('Also report VMs that are GKE nodes.'),
        limit: listLimit(100, 500),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => vmHealth(args)),
  );

  server.registerTool(
    'get_incidents',
    {
      title: 'Incidents and availability',
      description:
        'Incidents in the window: Cloud Monitoring alerts from your alerting policies (open and closed, with ' +
        'duration and affected resource), Google Cloud service outages affecting your projects (Personalized ' +
        'Service Health, if enabled), and availability % from uptime checks. Google Cloud does not record root ' +
        `cause: follow up with query_logs around each incident time. ${healthNote}`,
      inputSchema: {
        projectIds,
        hours: healthWindow(168, 24 * 42).describe('Look-back window in hours (max 1008). Default: 7 days.'),
        endTime,
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => incidents(args)),
  );

  server.registerTool(
    'query_logs',
    {
      title: 'Query logs',
      description:
        'Search Cloud Logging across projects for root-cause evidence, newest first. Presets: errors (severity ' +
        'ERROR+), k8s_warnings (Kubernetes warning events), oom, crashloop, changes (admin audit log: who changed ' +
        'what), cloudsql (Cloud SQL warnings), autoscaler. filter takes Logging query language and is ANDed with ' +
        'the preset; resourceName matches a cluster, instance or service name anywhere in the entry. Long windows ' +
        `can be slow: ${RUNNING_NOTE}`,
      inputSchema: {
        projectIds,
        preset: z.enum(Object.keys(PRESETS)).optional(),
        filter: z.string().max(2000).optional().describe('Extra Logging query, e.g. resource.type="k8s_container".'),
        resourceName: z.string().max(200).optional(),
        hours: healthWindow(24, 24 * 30),
        endTime,
        limit: z.number().int().min(1).max(200).default(50).describe('Max entries to return.'),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => logs(args)),
  );

  server.registerTool(
    'list_resources',
    {
      title: 'List resources',
      description:
        'Inventory of the resources running across projects (VMs, GKE clusters, Cloud SQL, Cloud Run, functions, ' +
        'Redis, buckets...), from Cloud Asset Inventory. By default only active ones: stopped, terminated or failed ' +
        'resources are left out but still counted. Each resource has a usageKind when get_resource_usage has ' +
        'metrics for it.',
      inputSchema: {
        projectIds,
        kinds: z
          .array(z.enum(Object.keys(KINDS)))
          .optional()
          .describe(`Resource kinds to include. Default: ${DEFAULT_KINDS.join(', ')}.`),
        includeInactive: z.boolean().default(false).describe('Also return stopped/terminated/failed resources.'),
        limit: z.number().int().min(1).max(1000).default(200).describe('Max resources to return.'),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => inventory.list(args)),
  );

  server.registerTool(
    'get_resource_usage',
    {
      title: 'Resource usage metrics',
      description:
        'CPU, memory and other utilization for one kind of resource across projects, from Cloud Monitoring, as ' +
        'avg / max / latest over a time window, busiest first. vm: CPU %, memory % and fullest disk % (need Ops ' +
        'Agent), network, Ops Agent presence. gke: per cluster CPU cores, memory, pod count, node count, node ' +
        'CPU/memory %, container restarts (breakdown "namespace" splits by namespace). cloudsql: uptime %, CPU, ' +
        'memory, disk %, connections, read/write IOPS. cloudrun: p95 CPU/memory %, requests/s, instances. uptime: ' +
        'availability % and latency per uptime check (worst first). logs: exact count of WARNING-or-worse log ' +
        'entries per resource type and severity. Use it to find idle or overloaded resources.',
      inputSchema: {
        kind: z
          .enum(Object.keys(USAGE))
          .describe(
            'Which kind of resource to report on. uptime = availability of Cloud Monitoring uptime checks; logs = ' +
              'warning/error log volume.',
          ),
        projectIds,
        hours: z
          .number()
          .int()
          .min(1)
          .max(24 * 42)
          .default(24)
          .describe('Look-back window in hours (max 6 weeks).'),
        endTime,
        names: z
          .array(z.string())
          .optional()
          .describe('Only these resources (VM, cluster, instance or service names).'),
        breakdown: z
          .enum(['resource', 'namespace'])
          .default('resource')
          .describe('gke only: "namespace" gives one row per cluster and namespace.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max rows to return.'),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => usage.usage(args)),
  );

  if (history) {
    registerHistoryTools(server, {
      history,
      handler,
      job: (fn, opts) => backgroundJob(fn, { waitMs, cacheMs, ...opts }),
      isoDate,
      projectIds,
    });
  }

  return server;
}

// Fills default dates ("today" in the cost source's time zone) and rejects inverted ranges.
export function withDates({ startDate, endDate, ...rest }, now = new Date(), timeZone = 'UTC') {
  const today = dateIn(timeZone, now);
  const start = startDate ?? `${today.slice(0, 8)}01`;
  const end = endDate ?? today;
  if (start > end) throw new ConfigError(`startDate ${start} is after endDate ${end}`);
  return { ...rest, startDate: start, endDate: end };
}

const MAX_JOBS = 100;

// Runs fn once per distinct arguments, shares the in-flight promise, and keeps the result for cacheMs.
// Returns a "still running" result if fn takes longer than waitMs.
//
// Failures: if a caller was waiting, it gets the error and the entry is dropped (so a retry runs again).
// If the job failed after every caller had given up waiting, the error is kept and thrown once on the next
// call with the same arguments; otherwise the model would loop running -> re-run -> running and never see it.
export function backgroundJob(fn, { waitMs, cacheMs, now = Date.now, what = 'building this cost report' }) {
  const jobs = new Map();

  function sweep() {
    const t = now();
    for (const [key, e] of jobs) if (e.doneAt && t - e.doneAt > cacheMs) jobs.delete(key);
    if (jobs.size > MAX_JOBS) {
      const finished = [...jobs].filter(([, e]) => e.doneAt).sort((a, b) => a[1].doneAt - b[1].doneAt);
      for (const [key] of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(key);
    }
  }

  return async (args) => {
    const key = JSON.stringify(args);
    sweep();
    let entry = jobs.get(key);
    if (entry?.error) {
      jobs.delete(key);
      throw entry.error;
    }
    if (!entry) {
      const startedAt = now();
      entry = { startedAt, waiters: 0 };
      entry.promise = Promise.resolve().then(() => fn(args));
      jobs.set(key, entry);
      entry.promise.then(
        () => (entry.doneAt = now()),
        (err) => {
          if (jobs.get(key) !== entry) return;
          if (entry.waiters > 0) jobs.delete(key);
          else Object.assign(entry, { error: err, doneAt: now() });
        },
      );
    }
    entry.waiters += 1;
    let timer;
    const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(PENDING), waitMs)));
    try {
      const result = await Promise.race([entry.promise, timeout]);
      if (result !== PENDING) return result;
      return {
        status: 'running',
        runningForSeconds: Math.round((now() - entry.startedAt) / 1000),
        message:
          `Google Cloud is still ${what}. Call this tool again with exactly the same arguments in about ` +
          '30 seconds to get the result; the work continues in the background.',
      };
    } finally {
      entry.waiters -= 1;
      clearTimeout(timer);
    }
  };
}

const PENDING = Symbol('pending');

// Wraps a tool so results are compact JSON and failures come back as readable tool errors
// (with a hint about the likely fix) instead of protocol errors.
function handler(fn) {
  return async (args) => {
    try {
      const result = await fn(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      // Message and code only: a raw HTTP error object would carry request headers.
      console.error('[gcp-monitor-mcp]', err?.code ?? '', err?.message ?? String(err));
      return { isError: true, content: [{ type: 'text', text: explain(err) }] };
    }
  };
}

export function explain(err) {
  const msg = err?.message ?? String(err);
  if (err instanceof ConfigError) return msg;
  if (/Could not load the default credentials|Unable to read the credential file|invalid_grant|reauth/i.test(msg)) {
    return `Google Cloud credentials are missing or expired. Run: gcloud auth application-default login (${msg})`;
  }
  if (/SERVICE_DISABLED|has not been used in project|it is disabled/i.test(msg)) {
    return `A required Google Cloud API is not enabled. Enable the API named below in that project (APIs & Services → Library). (${msg})`;
  }
  if (
    err?.code === 7 ||
    err?.code === 403 ||
    /PERMISSION_DENIED|permission denied|does not have .*permission|access denied/i.test(msg)
  ) {
    return (
      `Permission denied: ${msg}\nThe identity this server runs as needs roles/viewer on each project in scope ` +
      '(it covers every read tool), plus for cost tools either roles/appoptimize.admin on GCP_COST_REPORT_PROJECT ' +
      '(App Optimize) or roles/bigquery.dataViewer + roles/bigquery.jobUser (billing export).'
    );
  }
  if (/bytes billed/i.test(msg)) {
    return `Query would scan more than GCP_BQ_MAX_BYTES_BILLED allows. Narrow the date range or raise the limit. (${msg})`;
  }
  if (/Not found: (Table|Dataset)/i.test(msg)) {
    return `Billing export table not found. Check GCP_BILLING_EXPORT_TABLE. (${msg})`;
  }
  return msg;
}

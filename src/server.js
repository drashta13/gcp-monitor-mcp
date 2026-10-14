import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GROUP_BY, GRANULARITY, ConfigError } from './gcp/billing.js';
import { KINDS, DEFAULT_KINDS } from './gcp/inventory.js';
import { USAGE } from './gcp/metrics.js';
import { PRESETS } from './gcp/logs.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const costFilters = {
  startDate: isoDate.optional().describe('Inclusive start date, YYYY-MM-DD. Default: first day of the current month.'),
  endDate: isoDate.optional().describe('Inclusive end date, YYYY-MM-DD. Default: today.'),
  projectIds: z.array(z.string()).optional().describe('Limit to these project IDs. Default: all configured projects.'),
  service: z
    .string()
    .optional()
    .describe('Limit to one service by its billing name, e.g. "Compute Engine", "Cloud Run", "BigQuery".'),
};

const COST_NOTE =
  'Data comes from the Cloud Billing export to BigQuery, which lags real usage by a few hours to about a day; ' +
  'dataAsOf says how fresh it is. netCost = cost + credits (credits are negative). Amounts are in the billing account currency.';

// Cost reports take 15-60s+ to build in Google Cloud, and MCP clients give up on a tool call after about 60s.
// So a cost call waits up to WAIT_MS; if the report isn't ready, it returns a "still running" note while the
// work continues in the background, and the next call with the same arguments picks up the result.
const WAIT_MS = 45_000;
const CACHE_MS = 10 * 60_000; // cost data updates about daily; repeat questions in a chat are free

export function createServer({
  projects,
  billing,
  inventory,
  usage,
  health = {},
  waitMs = WAIT_MS,
  cacheMs = CACHE_MS,
}) {
  const job = (fn) => backgroundJob(fn, { waitMs, cacheMs });
  const costSummary = job((args) => billing.summary(args));
  const costTrend = job((args) => billing.trend(args));
  const costTop = job((args) => billing.topResources(args));
  const costComparison = job((args) => billing.comparison(args));

  const costNote =
    (billing.note ?? COST_NOTE) +
    ' Reports can take a minute: if a result has status "running", call again with the same arguments after ~30s.';
  const server = new McpServer({ name: 'gcp-monitor-mcp', version: '0.5.1' });

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
      const list = await projects.list();
      return { count: list.length, projects: list };
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
    handler(async (args) => costSummary(withDates(args))),
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
    handler(async (args) => costTrend(withDates(args))),
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
    handler(async (args) => costTop(withDates(args))),
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
        `fairly. Both windows must fit in the last 30 days. ${costNote}`,
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
        projectIds: costFilters.projectIds,
        service: costFilters.service,
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => costComparison(args)),
  );

  const healthWindow = (def, max) =>
    z.number().int().min(1).max(max).default(def).describe('Look-back window in hours.');
  const healthJob = (fn) => job((args) => fn(args));
  const sqlHealth = healthJob((a) => health.cloudsql.health(a));
  const gkeHealth = healthJob((a) => health.gke.health(a));
  const vmHealth = healthJob((a) => health.vm.health(a));
  const incidents = healthJob((a) => health.incidents.incidents(a));
  const logs = healthJob((a) => health.logs.query(a));

  server.registerTool(
    'get_cloudsql_health',
    {
      title: 'Cloud SQL health',
      description:
        'Health of every Cloud SQL instance: state, high availability / failover setup, automated backups, ' +
        'point-in-time recovery, last successful and failed backup runs, storage auto-resize, deletion protection, ' +
        'maintenance window and scheduled maintenance, plus uptime %, CPU, memory, disk %, connections and IOPS over ' +
        'the window. Each instance has an issues list; instances with the most issues come first.',
      inputSchema: {
        projectIds: costFilters.projectIds,
        names: z.array(z.string()).optional().describe('Only these instance names.'),
        hours: healthWindow(24, 24 * 42),
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
        'get_resource_usage kind "gke" with breakdown "namespace" for per-workload detail.',
      inputSchema: {
        projectIds: costFilters.projectIds,
        names: z.array(z.string()).optional().describe('Only these cluster names.'),
        hours: healthWindow(24, 24 * 30),
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
        'plus CPU, memory and fullest-disk % over the window. Also lists unattached disks.',
      inputSchema: {
        projectIds: costFilters.projectIds,
        names: z.array(z.string()).optional().describe('Only these VM names.'),
        hours: healthWindow(24, 24 * 42),
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
        'cause: follow up with query_logs around each incident time.',
      inputSchema: {
        projectIds: costFilters.projectIds,
        hours: healthWindow(168, 24 * 42).describe('Look-back window in hours. Default: 7 days.'),
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
        'can be slow: if a result has status "running", call again with the same arguments after ~30s.',
      inputSchema: {
        projectIds: costFilters.projectIds,
        preset: z.enum(Object.keys(PRESETS)).optional(),
        filter: z.string().max(2000).optional().describe('Extra Logging query, e.g. resource.type="k8s_container".'),
        resourceName: z.string().max(200).optional(),
        hours: healthWindow(24, 24 * 30),
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
        projectIds: costFilters.projectIds,
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
        'availability % and latency per uptime check (worst first). Use it to find idle or overloaded resources.',
      inputSchema: {
        kind: z
          .enum(Object.keys(USAGE))
          .describe('Which kind of resource to report on. uptime = availability of Cloud Monitoring uptime checks.'),
        projectIds: costFilters.projectIds,
        hours: z
          .number()
          .int()
          .min(1)
          .max(24 * 42)
          .default(24)
          .describe('Look-back window in hours (max 6 weeks).'),
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

  return server;
}

// Fills default dates and rejects inverted ranges.
export function withDates({ startDate, endDate, ...rest }, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const start = startDate ?? `${today.slice(0, 8)}01`;
  const end = endDate ?? today;
  if (start > end) throw new ConfigError(`startDate ${start} is after endDate ${end}`);
  return { ...rest, startDate: start, endDate: end };
}

// Runs fn once per distinct arguments, shares the in-flight promise, and keeps the result for cacheMs.
// Returns a "still running" result if fn takes longer than waitMs; failures are not cached.
export function backgroundJob(fn, { waitMs, cacheMs, now = Date.now }) {
  const jobs = new Map();
  return async (args) => {
    const key = JSON.stringify(args);
    let entry = jobs.get(key);
    if (!entry || (entry.doneAt && now() - entry.doneAt > cacheMs)) {
      const startedAt = now();
      const promise = fn(args);
      entry = { promise, startedAt };
      jobs.set(key, entry);
      promise.then(
        () => (entry.doneAt = now()),
        () => jobs.get(key) === entry && jobs.delete(key),
      );
    }
    let timer;
    const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(PENDING), waitMs)));
    try {
      const result = await Promise.race([entry.promise, timeout]);
      if (result !== PENDING) return result;
      return {
        status: 'running',
        runningForSeconds: Math.round((now() - entry.startedAt) / 1000),
        message:
          'Google Cloud is still building this cost report. Call this tool again with exactly the same ' +
          'arguments in about 30 seconds to get the result; the work continues in the background.',
      };
    } finally {
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
      console.error('[gcp-monitor-mcp]', err);
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

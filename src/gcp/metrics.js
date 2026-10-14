import { MetricServiceClient } from '@google-cloud/monitoring';
import { perProject, mapLimit, round } from './util.js';

// Curated Cloud Monitoring queries per resource kind. Each metric is aggregated server-side into one
// series per resource (groupBy), at ~48 points over the window, and summarized here as avg / max / latest.
// `scale` converts the raw unit (e.g. 0-1 ratios to percent, bytes to MiB).
const MiB = 1 / 2 ** 20;

export const USAGE = {
  vm: {
    groupBy: ['metadata.system_labels.name', 'resource.label.zone'],
    key: (l) => ({ name: l['metadata.system_labels.name'], location: l['resource.label.zone'] }),
    sortBy: 'cpuPercent',
    metrics: [
      m('cpuPercent', 'compute.googleapis.com/instance/cpu/utilization', 'ALIGN_MEAN', 'REDUCE_MEAN', 100),
      // Only reported when the Ops Agent is installed on the VM.
      m('memoryPercent', 'agent.googleapis.com/memory/percent_used', 'ALIGN_MEAN', 'REDUCE_MEAN', 1, {
        filter: 'metric.label.state = "used"',
      }),
      m(
        'networkInMiBps',
        'compute.googleapis.com/instance/network/received_bytes_count',
        'ALIGN_RATE',
        'REDUCE_SUM',
        MiB,
      ),
      m('networkOutMiBps', 'compute.googleapis.com/instance/network/sent_bytes_count', 'ALIGN_RATE', 'REDUCE_SUM', MiB),
      // Fullest disk on the VM. Ops Agent only.
      // Snap packages mount read-only loop devices that always read 100% full, so skip those.
      m('diskPercent', 'agent.googleapis.com/disk/percent_used', 'ALIGN_MEAN', 'REDUCE_MAX', 1, {
        filter:
          'metric.label.state = "used" AND ' +
          'NOT metric.label.device = monitoring.regex.full_match(".*(loop|tmpfs|squashfs|overlay|shm).*")',
      }),
      m('opsAgent', 'agent.googleapis.com/agent/uptime', 'ALIGN_DELTA', 'REDUCE_MAX', 1, { stat: 'present' }),
    ],
    notes:
      'memoryPercent and diskPercent (fullest disk) need the Ops Agent on the VM; without it they are missing and ' +
      'opsAgent is absent.',
  },

  gke: {
    groupBy: ['resource.label.cluster_name', 'resource.label.location'],
    key: (l) => ({ name: l['resource.label.cluster_name'], location: l['resource.label.location'] }),
    sortBy: 'cpuCores',
    metrics: [
      m('cpuCores', 'kubernetes.io/container/cpu/core_usage_time', 'ALIGN_RATE', 'REDUCE_SUM'),
      m('memoryMiB', 'kubernetes.io/container/memory/used_bytes', 'ALIGN_MEAN', 'REDUCE_SUM', MiB, {
        filter: 'metric.label.memory_type = "non-evictable"',
      }),
      m('pods', 'kubernetes.io/pod/network/received_bytes_count', 'ALIGN_RATE', 'REDUCE_COUNT'),
      m('containerRestarts', 'kubernetes.io/container/restart_count', 'ALIGN_DELTA', 'REDUCE_SUM', 1, {
        stat: 'total',
      }),
      m('nodes', 'kubernetes.io/node/cpu/allocatable_cores', 'ALIGN_MEAN', 'REDUCE_COUNT', 1, { node: true }),
      m('nodeCpuPercent', 'kubernetes.io/node/cpu/allocatable_utilization', 'ALIGN_MEAN', 'REDUCE_MEAN', 100, {
        node: true,
      }),
      m('nodeMemoryPercent', 'kubernetes.io/node/memory/allocatable_utilization', 'ALIGN_MEAN', 'REDUCE_MEAN', 100, {
        node: true,
        filter: 'metric.label.memory_type = "non-evictable"',
      }),
    ],
    notes:
      'cpuCores and memoryMiB are what containers actually use; nodeCpuPercent / nodeMemoryPercent are usage ' +
      'as a share of node capacity. pods counts pods with network traffic (hostNetwork pods are not counted).',
  },

  cloudsql: {
    groupBy: ['resource.label.database_id', 'resource.label.region'],
    key: (l) => ({ name: l['resource.label.database_id']?.split(':').pop(), location: l['resource.label.region'] }),
    sortBy: 'cpuPercent',
    metrics: [
      m('uptimePercent', 'cloudsql.googleapis.com/database/up', 'ALIGN_MEAN', 'REDUCE_MEAN', 100),
      m('cpuPercent', 'cloudsql.googleapis.com/database/cpu/utilization', 'ALIGN_MEAN', 'REDUCE_MEAN', 100),
      m('memoryPercent', 'cloudsql.googleapis.com/database/memory/utilization', 'ALIGN_MEAN', 'REDUCE_MEAN', 100),
      m('diskPercent', 'cloudsql.googleapis.com/database/disk/utilization', 'ALIGN_MEAN', 'REDUCE_MEAN', 100),
      // PostgreSQL and MySQL/SQL Server report connections under different metrics; whichever exists wins.
      m('connections', 'cloudsql.googleapis.com/database/postgresql/num_backends', 'ALIGN_MEAN', 'REDUCE_SUM'),
      m('connections', 'cloudsql.googleapis.com/database/network/connections', 'ALIGN_MEAN', 'REDUCE_SUM'),
      m('readIops', 'cloudsql.googleapis.com/database/disk/read_ops_count', 'ALIGN_RATE', 'REDUCE_SUM'),
      m('writeIops', 'cloudsql.googleapis.com/database/disk/write_ops_count', 'ALIGN_RATE', 'REDUCE_SUM'),
    ],
  },

  cloudrun: {
    groupBy: ['resource.label.service_name', 'resource.label.location'],
    key: (l) => ({ name: l['resource.label.service_name'], location: l['resource.label.location'] }),
    sortBy: 'requestsPerSec',
    metrics: [
      m('cpuPercentP95', 'run.googleapis.com/container/cpu/utilizations', 'ALIGN_PERCENTILE_95', 'REDUCE_MAX', 100),
      m(
        'memoryPercentP95',
        'run.googleapis.com/container/memory/utilizations',
        'ALIGN_PERCENTILE_95',
        'REDUCE_MAX',
        100,
      ),
      m('requestsPerSec', 'run.googleapis.com/request_count', 'ALIGN_RATE', 'REDUCE_SUM'),
      m('instances', 'run.googleapis.com/container/instance_count', 'ALIGN_MEAN', 'REDUCE_SUM'),
    ],
    notes: 'cpuPercentP95 / memoryPercentP95 are the 95th percentile across container instances.',
  },
};

// Availability from Cloud Monitoring uptime checks, one row per check.
USAGE.uptime = {
  groupBy: ['metric.label.check_id'],
  key: (l) => ({ name: l['metric.label.check_id'], location: 'global' }),
  sortBy: 'availabilityPercent',
  worstFirst: true,
  metrics: [
    m(
      'availabilityPercent',
      'monitoring.googleapis.com/uptime_check/check_passed',
      'ALIGN_FRACTION_TRUE',
      'REDUCE_MEAN',
      100,
    ),
    m('latencyMs', 'monitoring.googleapis.com/uptime_check/request_latency', 'ALIGN_MEAN', 'REDUCE_MEAN'),
  ],
  notes: 'availabilityPercent is the share of uptime check runs that passed, across all checker regions.',
};

function m(key, type, aligner, reducer, scale = 1, extra = {}) {
  return { key, type, aligner, reducer, scale, stat: 'series', ...extra };
}

const CONCURRENCY = 8;
const POINTS = 48;
const MIN_ALIGNMENT = 60;

// Needs monitoring.timeSeries.list on each project (roles/monitoring.viewer; roles/viewer includes it).
export function createUsageService({ scope }, injected, now = () => Date.now()) {
  let client = injected;

  return {
    async usage({ kind, projectIds, hours = 24, names, breakdown = 'resource', limit = 50 }) {
      const spec = USAGE[kind];
      const ids = await scope(projectIds);
      const end = Math.floor(now() / 1000);
      const start = end - hours * 3600;
      const alignment = Math.max(MIN_ALIGNMENT, Math.ceil((hours * 3600) / POINTS / 60) * 60);
      const byNamespace = kind === 'gke' && breakdown === 'namespace';
      const groupBy = byNamespace ? [...spec.groupBy, 'resource.label.namespace_name'] : spec.groupBy;
      const metrics = byNamespace ? spec.metrics.filter((x) => !x.node) : spec.metrics;

      client ??= new MetricServiceClient();
      let result;
      try {
        // Surface credential errors once, here; otherwise each parallel call hits the broken stub and gax can
        // throw outside the promise chain, killing the server.
        await client.initialize?.();
        result = await perProject(ids, 2, async (projectId) => {
          const settled = await mapLimit(metrics, CONCURRENCY, (metric) =>
            query(client, { projectId, metric, start, end, alignment, groupBy }),
          );
          // One metric failing (e.g. not available here) doesn't fail the project; all failing does.
          const failures = settled.filter((s) => s.status === 'rejected');
          if (failures.length === settled.length) throw failures[0].reason;
          return { projectId, settled };
        });
      } catch (err) {
        if (!injected) client = undefined;
        throw err;
      }

      const rows = new Map();
      for (const { projectId, settled } of result.ok) {
        settled.forEach((s, i) => {
          if (s.status !== 'fulfilled') return;
          const metric = metrics[i];
          for (const series of s.value) {
            const labels = seriesLabels(series, groupBy);
            const id = {
              ...spec.key(labels),
              ...(byNamespace ? { namespace: labels['resource.label.namespace_name'] } : {}),
            };
            const rowKey = JSON.stringify([projectId, id]);
            const row = rows.get(rowKey) ?? rows.set(rowKey, { ...id, projectId, metrics: {} }).get(rowKey);
            row.metrics[metric.key] ??= summarize(series.points ?? [], metric);
          }
        });
      }

      let list = [...rows.values()];
      if (names?.length) list = list.filter((r) => names.includes(r.name));
      const sortKey = spec.sortBy;
      // Busiest first; for availability, worst first.
      const dir = spec.worstFirst ? -1 : 1;
      list.sort((a, b) => dir * ((b.metrics[sortKey]?.avg ?? -1) - (a.metrics[sortKey]?.avg ?? -1)));

      return {
        kind,
        breakdown: byNamespace ? 'namespace' : 'resource',
        window: { hours, start: iso(start), end: iso(end), alignmentSeconds: alignment },
        metrics: Object.fromEntries(metrics.map((x) => [x.key, x.type])),
        ...(spec.notes ? { notes: spec.notes } : {}),
        returned: Math.min(list.length, limit),
        truncated: list.length > limit,
        resources: list.slice(0, limit),
        ...(result.failed.length ? { failedProjects: result.failed } : {}),
      };
    },
  };
}

async function query(client, { projectId, metric, start, end, alignment, groupBy }) {
  const filter = [`metric.type = "${metric.type}"`, metric.filter].filter(Boolean).join(' AND ');
  let series;
  try {
    [series] = await client.listTimeSeries({
      name: `projects/${projectId}`,
      filter,
      interval: { startTime: { seconds: start }, endTime: { seconds: end } },
      aggregation: {
        alignmentPeriod: { seconds: alignment },
        perSeriesAligner: metric.aligner,
        crossSeriesReducer: metric.reducer,
        groupByFields: groupBy,
      },
      view: 'FULL',
    });
  } catch (err) {
    // A metric type nothing in the project has ever written (no GKE, no Ops Agent...) is "no data".
    if (err?.code === 3 && /cannot find metric|could not find|unknown metric/i.test(err.message)) return [];
    throw err;
  }
  return series ?? [];
}

// Reads grouped label values back out of a series, keyed the same way as groupByFields.
export function seriesLabels(series, fields) {
  const out = {};
  for (const f of fields) {
    const [scope, , name] = f.split('.');
    if (scope === 'resource') out[f] = series.resource?.labels?.[name];
    else if (scope === 'metric') out[f] = series.metric?.labels?.[name];
    else if (scope === 'metadata') out[f] = series.metadata?.systemLabels?.fields?.[name]?.stringValue;
  }
  return out;
}

// Points arrive newest first.
export function summarize(points, { scale, stat }) {
  const values = points
    .map(pointValue)
    .filter((v) => v != null && Number.isFinite(v))
    .map((v) => v * scale);
  if (!values.length) return null;
  if (stat === 'total') return { total: round(values.reduce((a, b) => a + b, 0)) };
  if (stat === 'present') return { reporting: true };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { avg: round(avg), max: round(Math.max(...values)), latest: round(values[0]) };
}

function pointValue(p) {
  const v = p.value ?? {};
  if (v.doubleValue != null) return Number(v.doubleValue);
  if (v.int64Value != null) return Number(v.int64Value);
  return null;
}

const iso = (s) => new Date(s * 1000).toISOString();

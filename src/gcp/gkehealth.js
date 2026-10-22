import { projectNotes, perProject, tally, fromMap, windowEnd, metricsWithoutResource } from './util.js';
import { seg } from './rest.js';

const GKE = 'https://container.googleapis.com/v1';
const LOGGING = 'https://logging.googleapis.com/v2/entries:list';

// Kubernetes event reasons worth surfacing in a health report. ("Killing" is a Normal event on every pod
// termination; on a busy cluster it would eat the whole event budget.)
const EVENT_REASONS = [
  'OOMKilling',
  'BackOff',
  'CrashLoopBackOff',
  'Unhealthy',
  'FailedScheduling',
  'Evicted',
  'NodeNotReady',
  'FailedMount',
];
const MAX_EVENTS = 1000;

export const THRESHOLDS = {
  containerRestarts: 10, // restarts over the window
  nodeCpuPercent: 80, // average
  nodeMemoryPercent: 85, // average
};

// GKE health: cluster and node pool config (versions, upgrades, autoscaling, auto-repair) from the GKE API,
// warning events and autoscaler decisions from Cloud Logging, and restarts / nodes / pods from Monitoring.
// Needs container.clusters.list and logging.logEntries.list (both in roles/viewer).
export function createGkeHealthService({ scope, rest, usage, now = Date.now }) {
  async function forProject(projectId, hours, endTime) {
    const end = windowEnd(endTime, now);
    const since = new Date(end - hours * 3600_000).toISOString();
    // An explicit end bounds the log searches too; without one they run up to now.
    const until = endTime ? new Date(end).toISOString() : null;
    const [clusters, events, autoscaler] = await Promise.all([
      rest.get(`${GKE}/projects/${seg(projectId)}/locations/-/clusters`).then((d) => d?.clusters ?? []),
      logCounts(rest, projectId, eventsFilter(since, until)).catch((err) => ({ error: err.message })),
      logCounts(rest, projectId, autoscalerFilter(since, until)).catch((err) => ({ error: err.message })),
    ]);
    return { projectId, clusters, events, autoscaler };
  }

  return {
    async health({ projectIds, names, hours = 24, endTime }) {
      const ids = await scope(projectIds);
      const [config, metrics] = await Promise.all([
        perProject(ids, 4, (id) => forProject(id, hours, endTime)),
        usage.usage({ kind: 'gke', projectIds: ids, hours, endTime, limit: Infinity }).catch((err) => ({ error: err.message })),
      ]);
      const metricsByName = new Map((metrics.resources ?? []).map((r) => [`${r.projectId}/${r.name}`, r.metrics]));
      const counts = (result, name) => (result.error ? result : fromMap(result.byCluster.get(name) ?? new Map()));

      const rows = [];
      // A past window (endTime): clusters created after it are left out, and clusters deleted since keep
      // their metrics under notFoundNow.
      const windowEndMs = endTime ? Date.parse(endTime) : null;
      const seen = new Set();
      for (const { projectId, clusters, events, autoscaler } of config.ok) {
        for (const c of clusters) {
          seen.add(`${projectId}/${c.name}`);
          if (names?.length && !names.includes(c.name)) continue;
          if (windowEndMs && Date.parse(c.createTime) >= windowEndMs) continue;
          rows.push(
            describe(projectId, c, {
              events: counts(events, c.name),
              autoscaler: counts(autoscaler, c.name),
              truncated: events.truncated || autoscaler.truncated,
              metrics: metricsByName.get(`${projectId}/${c.name}`),
            }),
          );
        }
      }
      rows.sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));
      const notFoundNow = windowEndMs && !names?.length ? metricsWithoutResource(metricsByName, seen) : [];

      return {
        window: { hours, ...(endTime ? { end: endTime } : {}) },
        summary: { clusters: rows.length, withIssues: rows.filter((r) => r.issues.length).length },
        clusters: rows,
        ...(notFoundNow.length ? { notFoundNow } : {}),
        notes:
          'events counts Kubernetes warning events by reason (e.g. OOMKilling, BackOff = crash looping). ' +
          'Use query_logs with preset "k8s_warnings" for the individual events.',
        ...(metrics.error ? { metricsError: metrics.error } : {}),
        ...(metrics.metricErrors ? { metricErrors: metrics.metricErrors } : {}),
        ...projectNotes(config),
      };
    },
  };
}

const timeRange = (since, until) => `timestamp>="${since}"${until ? ` AND timestamp<"${until}"` : ''}`;

function eventsFilter(since, until) {
  const reasons = EVENT_REASONS.map((r) => `"${r}"`).join(' OR ');
  return `logName:"logs/events" AND jsonPayload.reason=(${reasons}) AND ${timeRange(since, until)}`;
}

function autoscalerFilter(since, until) {
  return (
    'logName:"cluster-autoscaler-visibility" AND ' +
    `(jsonPayload.decision.scaleUp:* OR jsonPayload.decision.scaleDown:* OR jsonPayload.noDecisionStatus.noScaleUp:*) AND ${timeRange(since, until)}`
  );
}

// Counts matching log entries per cluster and kind. Lists at most MAX_EVENTS entries, so counts are a
// floor when `truncated` is set. Maps, not objects: cluster names and reasons are text from the logs.
async function logCounts(rest, projectId, filter) {
  const { items, truncated } = await rest.list(LOGGING, {
    post: true,
    key: 'entries',
    max: MAX_EVENTS,
    params: { resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp desc', pageSize: 1000 },
  });
  const byCluster = new Map();
  for (const e of items) {
    const cluster = e.resource?.labels?.cluster_name ?? '(unknown)';
    const kind = e.jsonPayload?.reason ?? autoscalerKind(e.jsonPayload);
    tally(byCluster.get(cluster) ?? byCluster.set(cluster, new Map()).get(cluster), kind);
  }
  return { byCluster, truncated };
}

function autoscalerKind(p = {}) {
  if (p.decision?.scaleUp) return 'scaleUp';
  if (p.decision?.scaleDown) return 'scaleDown';
  if (p.noDecisionStatus?.noScaleUp) return 'scaleUpBlocked';
  return 'other';
}

export function describe(projectId, c, { events, autoscaler, truncated, metrics }) {
  const pools = (c.nodePools ?? []).map((p) => ({
    name: p.name,
    version: p.version,
    status: p.status,
    machineType: p.config?.machineType,
    nodes: p.autoscaling?.enabled
      ? {
          autoscaling: true,
          min: p.autoscaling.minNodeCount ?? p.autoscaling.totalMinNodeCount,
          max: p.autoscaling.maxNodeCount ?? p.autoscaling.totalMaxNodeCount,
        }
      : { autoscaling: false, initial: p.initialNodeCount },
    autoUpgrade: Boolean(p.management?.autoUpgrade),
    autoRepair: Boolean(p.management?.autoRepair),
    spot: Boolean(p.config?.spot || p.config?.preemptible),
  }));

  const autopilot = Boolean(c.autopilot?.enabled);
  const issues = [];
  if (c.status !== 'RUNNING') issues.push(`cluster status ${c.status}`);
  for (const cond of c.conditions ?? []) issues.push(`cluster condition: ${cond.message ?? cond.code}`);
  if (!c.releaseChannel?.channel || c.releaseChannel.channel === 'UNSPECIFIED')
    issues.push('no release channel: upgrades are manual');
  for (const p of pools) {
    if (p.status !== 'RUNNING') issues.push(`node pool ${p.name} status ${p.status}`);
    if (p.version && c.currentMasterVersion && minor(p.version) !== minor(c.currentMasterVersion))
      issues.push(`node pool ${p.name} on ${p.version}, control plane on ${c.currentMasterVersion}`);
    if (!autopilot && !p.autoRepair) issues.push(`node pool ${p.name} has auto-repair off`);
  }
  if (!events.error) {
    if (events.OOMKilling) issues.push(`${events.OOMKilling} OOM kill event(s)`);
    const crash = (events.BackOff ?? 0) + (events.CrashLoopBackOff ?? 0);
    if (crash) issues.push(`${crash} crash-loop back-off event(s)`);
    if (events.FailedScheduling) issues.push(`${events.FailedScheduling} pod scheduling failure(s)`);
    // Nodes being removed by scale-down report NotReady first, so only flag it when nothing scaled down.
    if (events.NodeNotReady && !autoscaler.scaleDown) issues.push(`${events.NodeNotReady} node-not-ready event(s)`);
    if (events.Evicted) issues.push(`${events.Evicted} pod eviction(s)`);
  }
  if (!autoscaler.error && autoscaler.scaleUpBlocked) issues.push(`${autoscaler.scaleUpBlocked} blocked scale-up(s)`);
  if (metrics?.containerRestarts?.total >= THRESHOLDS.containerRestarts)
    issues.push(`${metrics.containerRestarts.total} container restarts`);
  if (metrics?.nodeCpuPercent?.avg >= THRESHOLDS.nodeCpuPercent)
    issues.push(`node CPU averaging ${metrics.nodeCpuPercent.avg}%`);
  if (metrics?.nodeMemoryPercent?.avg >= THRESHOLDS.nodeMemoryPercent)
    issues.push(`node memory averaging ${metrics.nodeMemoryPercent.avg}%`);

  return {
    name: c.name,
    projectId,
    location: c.location,
    status: c.status,
    mode: autopilot ? 'autopilot' : 'standard',
    versions: {
      controlPlane: c.currentMasterVersion,
      nodes: c.currentNodeVersion ?? null,
      releaseChannel: c.releaseChannel?.channel ?? 'UNSPECIFIED',
    },
    nodeCount: c.currentNodeCount ?? null,
    nodePools: autopilot
      ? {
          managedByAutopilot: true,
          count: pools.length,
          versions: [...new Set(pools.map((p) => p.version))],
          notRunning: pools.filter((p) => p.status !== 'RUNNING').map((p) => p.name),
        }
      : pools,
    events: events.error ? { error: events.error } : events,
    autoscaling: autoscaler.error ? { error: autoscaler.error } : autoscaler,
    ...(truncated ? { countsAreLowerBounds: true } : {}),
    metrics: metrics ?? null,
    issues,
  };
}

const minor = (v) => v.split('.').slice(0, 2).join('.');

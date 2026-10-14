import { projectNotes, perProject } from './util.js';

const GKE = 'https://container.googleapis.com/v1';
const LOGGING = 'https://logging.googleapis.com/v2/entries:list';

// Kubernetes event reasons worth surfacing in a health report.
const EVENT_REASONS = [
  'OOMKilling',
  'BackOff',
  'CrashLoopBackOff',
  'Unhealthy',
  'FailedScheduling',
  'Evicted',
  'NodeNotReady',
  'FailedMount',
  'Killing',
];
const MAX_EVENTS = 1000;

// GKE health: cluster and node pool config (versions, upgrades, autoscaling, auto-repair) from the GKE API,
// warning events and autoscaler decisions from Cloud Logging, and restarts / nodes / pods from Monitoring.
// Needs container.clusters.list and logging.logEntries.list (both in roles/viewer).
export function createGkeHealthService({ scope, rest, usage, now = Date.now }) {
  async function forProject(projectId, hours) {
    const since = new Date(now() - hours * 3600_000).toISOString();
    const [clusters, events, autoscaler] = await Promise.all([
      rest.get(`${GKE}/projects/${projectId}/locations/-/clusters`).then((d) => d?.clusters ?? []),
      logCounts(rest, projectId, eventsFilter(since)).catch((err) => ({ error: err.message })),
      logCounts(rest, projectId, autoscalerFilter(since)).catch((err) => ({ error: err.message })),
    ]);
    return { projectId, clusters, events, autoscaler };
  }

  return {
    async health({ projectIds, names, hours = 24 }) {
      const ids = await scope(projectIds);
      const [config, metrics] = await Promise.all([
        perProject(ids, 4, (id) => forProject(id, hours)),
        usage.usage({ kind: 'gke', projectIds: ids, hours, limit: 200 }).catch((err) => ({ error: err.message })),
      ]);
      const metricsByName = new Map((metrics.resources ?? []).map((r) => [`${r.projectId}/${r.name}`, r.metrics]));

      const rows = [];
      for (const { projectId, clusters, events, autoscaler } of config.ok) {
        for (const c of clusters) {
          if (names?.length && !names.includes(c.name)) continue;
          rows.push(
            describe(projectId, c, {
              events: events.error ? events : (events.byCluster?.[c.name] ?? {}),
              autoscaler: autoscaler.error ? autoscaler : (autoscaler.byCluster?.[c.name] ?? {}),
              truncated: events.truncated || autoscaler.truncated,
              metrics: metricsByName.get(`${projectId}/${c.name}`),
            }),
          );
        }
      }
      rows.sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));

      return {
        window: { hours },
        summary: { clusters: rows.length, withIssues: rows.filter((r) => r.issues.length).length },
        clusters: rows,
        notes:
          'events counts Kubernetes warning events by reason (e.g. OOMKilling, BackOff = crash looping). ' +
          'Use query_logs with preset "k8s_warnings" for the individual events.',
        ...(metrics.error ? { metricsError: metrics.error } : {}),
        ...projectNotes(config),
      };
    },
  };
}

function eventsFilter(since) {
  const reasons = EVENT_REASONS.map((r) => `"${r}"`).join(' OR ');
  return `logName:"logs/events" AND jsonPayload.reason=(${reasons}) AND timestamp>="${since}"`;
}

function autoscalerFilter(since) {
  return (
    'logName:"cluster-autoscaler-visibility" AND ' +
    `(jsonPayload.decision.scaleUp:* OR jsonPayload.decision.scaleDown:* OR jsonPayload.noDecisionStatus.noScaleUp:*) AND timestamp>="${since}"`
  );
}

// Counts matching log entries per cluster and kind. Lists at most MAX_EVENTS entries, so counts are a
// floor when `truncated` is set.
async function logCounts(rest, projectId, filter) {
  const { items, truncated } = await rest.list(LOGGING, {
    post: true,
    key: 'entries',
    max: MAX_EVENTS,
    params: { resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp desc', pageSize: 1000 },
  });
  const byCluster = {};
  for (const e of items) {
    const cluster = e.resource?.labels?.cluster_name ?? '(unknown)';
    const kind = e.jsonPayload?.reason ?? autoscalerKind(e.jsonPayload);
    byCluster[cluster] ??= {};
    byCluster[cluster][kind] = (byCluster[cluster][kind] ?? 0) + 1;
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
  if (metrics?.containerRestarts?.total >= 10) issues.push(`${metrics.containerRestarts.total} container restarts`);
  if (metrics?.nodeCpuPercent?.avg >= 80) issues.push(`node CPU averaging ${metrics.nodeCpuPercent.avg}%`);
  if (metrics?.nodeMemoryPercent?.avg >= 85) issues.push(`node memory averaging ${metrics.nodeMemoryPercent.avg}%`);

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

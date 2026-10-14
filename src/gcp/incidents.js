import { perProject } from './util.js';

const MONITORING = 'https://monitoring.googleapis.com/v3';
const SERVICE_HEALTH = 'https://servicehealth.googleapis.com/v1';
const MAX_ALERTS = 500;

// Incidents from two places:
//  - Cloud Monitoring alerts: your own alerting policies firing (needs monitoring.alerts.list;
//    roles/viewer has it).
//  - Personalized Service Health: Google Cloud outages that affect your projects (needs the Service
//    Health API enabled and servicehealth.events.list; roles/viewer has it). Optional: reported as
//    unavailable if not set up.
// Plus availability from uptime checks, when any exist.
export function createIncidentsService({ scope, rest, usage, now = Date.now }) {
  async function alerts(projectId, since) {
    const { items, truncated } = await rest.list(`${MONITORING}/projects/${projectId}/alerts`, {
      key: 'alerts',
      max: MAX_ALERTS,
      params: { orderBy: 'open_time desc', pageSize: 200 },
    });
    // Ordered newest first; keep the ones open now or opened in the window.
    const relevant = items.filter((a) => a.state === 'OPEN' || (a.openTime ?? '') >= since);
    return { projectId, alerts: relevant.map((a) => toAlert(a, projectId, now())), truncated };
  }

  async function googleEvents(projectId, since) {
    const { items } = await rest.list(`${SERVICE_HEALTH}/projects/${projectId}/locations/global/events`, {
      key: 'events',
      max: 100,
      params: { pageSize: 100 },
    });
    return items
      .filter((e) => e.state === 'ACTIVE' || (e.updateTime ?? '') >= since)
      .map((e) => ({
        title: e.title,
        category: e.category,
        state: e.state,
        detailedState: e.detailedState,
        relevance: e.relevance,
        startTime: e.startTime,
        endTime: e.endTime ?? null,
        products: [...new Set((e.eventImpacts ?? []).map((i) => i.product?.productName).filter(Boolean))],
        locations: [...new Set((e.eventImpacts ?? []).map((i) => i.location?.locationName).filter(Boolean))],
        description: e.description?.slice(0, 500),
        projectId,
      }));
  }

  return {
    async incidents({ projectIds, hours = 168 }) {
      const ids = await scope(projectIds);
      const since = new Date(now() - hours * 3600_000).toISOString();

      const [alertResult, gcpEvents, uptime] = await Promise.all([
        perProject(ids, 4, (id) => alerts(id, since)),
        // Optional source: report it as unavailable unless at least one project has the API on.
        Promise.allSettled(ids.map((id) => googleEvents(id, since))).then((settled) => {
          const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
          return ok.length ? { ok } : { error: settled[0]?.reason?.message ?? 'no projects' };
        }),
        usage.usage({ kind: 'uptime', projectIds: ids, hours, limit: 100 }).catch((err) => ({ error: err.message })),
      ]);

      const all = alertResult.ok.flatMap((r) => r.alerts);
      all.sort((a, b) => (b.openTime ?? '').localeCompare(a.openTime ?? ''));

      const byPolicy = {};
      for (const a of all) {
        const p = (byPolicy[a.policy] ??= {
          policy: a.policy,
          severity: a.severity,
          count: 0,
          open: 0,
          totalMinutes: 0,
        });
        p.count += 1;
        if (a.state === 'OPEN') p.open += 1;
        p.totalMinutes += a.durationMinutes ?? 0;
      }

      // Uniq Google events across projects (the same outage shows up in each affected project).
      const events = gcpEvents.error ? null : uniqBy(gcpEvents.ok.flat(), (e) => `${e.title}|${e.startTime}`);

      return {
        window: { hours, since },
        summary: {
          incidents: all.length,
          open: all.filter((a) => a.state === 'OPEN').length,
          googleCloudEvents: events?.length ?? null,
          uptimeChecks: uptime.resources?.length ?? 0,
        },
        byPolicy: Object.values(byPolicy).sort((a, b) => b.count - a.count),
        incidents: all.slice(0, 100),
        googleCloudEvents: events ?? { unavailable: gcpEvents.error },
        availability: uptime.error ? { error: uptime.error } : uptime.resources,
        notes:
          'Incidents are Cloud Monitoring alerts from your alerting policies; with no policies there are none. ' +
          'Root cause is not stored by Google Cloud: use query_logs (presets errors, changes, k8s_warnings, oom) ' +
          'around each incident openTime for evidence.',
        ...(alertResult.failed.length ? { failedProjects: alertResult.failed } : {}),
      };
    },
  };
}

function toAlert(a, projectId, nowMs) {
  const open = Date.parse(a.openTime);
  const close = a.closeTime ? Date.parse(a.closeTime) : nowMs;
  const labels = a.resource?.labels ?? {};
  return {
    policy: a.policy?.displayName ?? a.policy?.name ?? '(unknown policy)',
    severity: a.policy?.severity ?? null,
    state: a.state,
    openTime: a.openTime,
    closeTime: a.closeTime ?? null,
    durationMinutes: Number.isFinite(open) ? Math.round((close - open) / 60_000) : null,
    resource: {
      type: a.resource?.type,
      name:
        labels.cluster_name ??
        labels.database_id?.split(':').pop() ??
        labels.instance_id ??
        labels.service_name ??
        null,
      labels,
    },
    metric: a.metric?.type ?? null,
    log: a.log ? true : undefined,
    projectId,
  };
}

function uniqBy(list, fn) {
  const seen = new Set();
  return list.filter((x) => !seen.has(fn(x)) && seen.add(fn(x)));
}

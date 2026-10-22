import { perProject, windowEnd } from './util.js';
import { seg } from './rest.js';

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
  async function alerts(projectId, since, until) {
    // Server-side: open now, or opened in the window. Without it an alert still open from before the
    // newest MAX_ALERTS would never be seen. (The API takes whole seconds only.) A past window asks for the
    // alerts that overlapped it: opened before its end, and still open or closed after its start. The alerts
    // API only takes =, :, >= and <= comparisons, so the exclusive end is "<= end minus a second".
    const filter = until
      ? `(state="OPEN" OR close_time>="${seconds(since)}") AND open_time<="${seconds(addHours(until, -1 / 3600))}"`
      : `state="OPEN" OR open_time>="${seconds(since)}"`;
    const { items, truncated } = await rest.list(`${MONITORING}/projects/${seg(projectId)}/alerts`, {
      key: 'alerts',
      max: MAX_ALERTS,
      params: { orderBy: 'open_time desc', pageSize: 200, filter },
    });
    const relevant = until
      ? // Overlaps [since, until): opened before the end, and still open or closed after the start.
        items.filter((a) => (a.openTime ?? '') < until && (!a.closeTime || a.closeTime >= since))
      : items.filter((a) => a.state === 'OPEN' || (a.openTime ?? '') >= since);
    return { projectId, alerts: relevant.map((a) => toAlert(a, projectId, now(), until && { since, until })), truncated };
  }

  async function googleEvents(projectId, since, until) {
    const { items } = await rest.list(`${SERVICE_HEALTH}/projects/${seg(projectId)}/locations/global/events`, {
      key: 'events',
      max: 100,
      params: { pageSize: 100 },
    });
    return items
      // A past window keeps events that overlapped it; Google keeps editing old events, so updateTime alone
      // would pull a week-old outage into every later day. Some events carry no start or end time: then the
      // update time stands in, and only an ACTIVE event is open-ended.
      .filter((e) => {
        if (!until) return e.state === 'ACTIVE' || (e.updateTime ?? '') >= since;
        const start = e.startTime ?? e.updateTime ?? '';
        const end = e.endTime ?? (e.state === 'ACTIVE' ? null : (e.updateTime ?? start));
        return start < until && (end == null || end >= since);
      })
      .map((e) => ({
        title: e.title,
        category: e.category,
        state: e.state,
        detailedState: e.detailedState,
        relevance: e.relevance,
        startTime: e.startTime ?? null,
        endTime: e.endTime ?? null,
        updateTime: e.updateTime ?? null,
        products: [...new Set((e.eventImpacts ?? []).map((i) => i.product?.productName).filter(Boolean))],
        locations: [...new Set((e.eventImpacts ?? []).map((i) => i.location?.locationName).filter(Boolean))],
        description: e.description?.slice(0, 500),
        projectId,
      }));
  }

  return {
    async incidents({ projectIds, hours = 168, endTime }) {
      const ids = await scope(projectIds);
      const end = windowEnd(endTime, now);
      const since = new Date(end - hours * 3600_000).toISOString();
      const until = endTime ? new Date(end).toISOString() : null;

      const [alertResult, gcpEvents, uptime] = await Promise.all([
        perProject(ids, 4, (id) => alerts(id, since, until)),
        // Optional source: report it as unavailable unless at least one project has the API on.
        Promise.allSettled(ids.map((id) => googleEvents(id, since, until))).then((settled) => {
          const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
          return ok.length ? { ok } : { error: settled[0]?.reason?.message ?? 'no projects' };
        }),
        usage.usage({ kind: 'uptime', projectIds: ids, hours, endTime, limit: Infinity }).catch((err) => ({ error: err.message })),
      ]);

      const all = alertResult.ok.flatMap((r) => r.alerts);
      all.sort((a, b) => (b.openTime ?? '').localeCompare(a.openTime ?? ''));
      const alertsTruncatedIn = alertResult.ok.filter((r) => r.truncated).map((r) => r.projectId);

      // For a past window, "open" means open when the window ended, and minutes count only those inside it.
      const openAtEnd = (a) => a.openAtWindowEnd ?? a.state === 'OPEN';
      // Keyed by policy display name, which is text from the alerting policy: use a Map.
      const byPolicy = new Map();
      for (const a of all) {
        const p =
          byPolicy.get(a.policy) ??
          byPolicy
            .set(a.policy, { policy: a.policy, severity: a.severity, count: 0, open: 0, totalMinutes: 0 })
            .get(a.policy);
        p.count += 1;
        if (openAtEnd(a)) p.open += 1;
        p.totalMinutes += a.minutesInWindow ?? a.durationMinutes ?? 0;
      }

      // Uniq Google events across projects (the same outage shows up in each affected project).
      const events = gcpEvents.error ? null : uniqBy(gcpEvents.ok.flat(), (e) => `${e.title}|${e.startTime}`);

      return {
        window: { hours, since, ...(until ? { until } : {}) },
        summary: {
          incidents: all.length,
          open: all.filter(openAtEnd).length,
          googleCloudEvents: events?.length ?? null,
          uptimeChecks: uptime.resources?.length ?? 0,
        },
        byPolicy: [...byPolicy.values()].sort((a, b) => b.count - a.count),
        incidents: all.slice(0, 100),
        ...(alertsTruncatedIn.length
          ? { alertsTruncatedIn, alertsNote: `Only the newest ${MAX_ALERTS} alerts per project were read; counts are lower bounds.` }
          : {}),
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

function toAlert(a, projectId, nowMs, window) {
  const open = Date.parse(a.openTime);
  const close = a.closeTime ? Date.parse(a.closeTime) : nowMs;
  // A past window: how much of the alert fell inside it, and whether it was still open at its end.
  const inWindow = window && {
    minutesInWindow: Number.isFinite(open)
      ? Math.max(0, Math.round((Math.min(close, Date.parse(window.until)) - Math.max(open, Date.parse(window.since))) / 60_000))
      : null,
    openAtWindowEnd: !a.closeTime || Date.parse(a.closeTime) >= Date.parse(window.until),
  };
  const labels = a.resource?.labels ?? {};
  return {
    policy: a.policy?.displayName ?? a.policy?.name ?? '(unknown policy)',
    severity: a.policy?.severity ?? null,
    state: a.state,
    openTime: a.openTime,
    closeTime: a.closeTime ?? null,
    durationMinutes: Number.isFinite(open) ? Math.round((close - open) / 60_000) : null,
    ...inWindow,
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

const seconds = (iso) => iso.replace(/\.\d+Z$/, 'Z');
const addHours = (iso, h) => new Date(Date.parse(iso) + h * 3600_000).toISOString();

function uniqBy(list, fn) {
  const seen = new Set();
  return list.filter((x) => !seen.has(fn(x)) && seen.add(fn(x)));
}

import { perProject, projectNotes, tally, fromMap, windowEnd } from './util.js';

const LOGGING = 'https://logging.googleapis.com/v2/entries:list';

// Ready-made filters for root-cause digging. Combined with the caller's own filter by AND.
export const PRESETS = {
  errors: 'severity>=ERROR',
  k8s_warnings: 'logName:"logs/events" AND jsonPayload.type="Warning"',
  // Scoped to the Kubernetes events log: a full-text search over every log is too slow over days.
  oom: 'logName:"logs/events" AND (jsonPayload.reason="OOMKilling" OR jsonPayload.message:"OOMKilled")',
  crashloop: 'logName:"logs/events" AND jsonPayload.reason=("BackOff" OR "CrashLoopBackOff")',
  // Admin Activity audit logs: who changed what (deploys, config edits, resizes, deletes). Kubernetes
  // control-plane chatter (lease renewals, system controllers, Google service agents) is excluded.
  changes:
    'logName:"cloudaudit.googleapis.com%2Factivity" ' +
    'AND NOT protoPayload.methodName:("get" OR "list" OR "watch" OR "leases" OR "tokenreviews" OR "subjectaccessreviews") ' +
    'AND NOT protoPayload.authenticationInfo.principalEmail:("system:" OR "container-engine-robot" OR "gcp-sa-")',
  cloudsql: 'resource.type="cloudsql_database" AND severity>=WARNING',
  autoscaler: 'logName:"cluster-autoscaler-visibility"',
};

const MESSAGE_CHARS = 500;

// Needs logging.logEntries.list (roles/logging.viewer; roles/viewer has it). Data Access audit logs and
// other private logs need roles/logging.privateLogViewer and are not covered.
export function createLogsService({ scope, rest, now = Date.now }) {
  return {
    async query({ projectIds, preset, filter, hours = 24, endTime, limit = 50, resourceName }) {
      const ids = await scope(projectIds);
      const end = windowEnd(endTime, now);
      const since = new Date(end - hours * 3600_000).toISOString();
      const until = endTime ? new Date(end).toISOString() : null;
      const parts = [
        `timestamp>="${since}"`,
        until ? `timestamp<"${until}"` : null,
        preset ? PRESETS[preset] : null,
        filter ? `(${filter})` : null,
        // Plain name match anywhere in the resource labels, e.g. a cluster, instance or service name.
        // Quotes and backslashes are dropped so the name can't close the string.
        resourceName ? `"${resourceName.replace(/["\\]/g, '')}"` : null,
      ].filter(Boolean);
      const fullFilter = parts.join(' AND ');

      const result = await perProject(ids, 4, async (projectId) => {
        const { items, truncated } = await rest.list(LOGGING, {
          post: true,
          key: 'entries',
          max: limit,
          params: {
            resourceNames: [`projects/${projectId}`],
            filter: fullFilter,
            orderBy: 'timestamp desc',
            pageSize: Math.min(limit, 1000),
          },
        });
        return { projectId, items, truncated };
      });

      const all = result.ok
        .flatMap(({ projectId, items }) => items.map((e) => toEntry(e, projectId)))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const entries = all.slice(0, limit);

      return {
        filter: fullFilter,
        window: { hours, since, ...(until ? { until } : {}) },
        returned: entries.length,
        truncated: result.ok.some((r) => r.truncated) || all.length > limit,
        bySeverity: countBy(entries, (e) => e.severity),
        byResource: countBy(entries, (e) => `${e.resource.type}:${e.resource.name ?? ''}`),
        entries,
        ...projectNotes(result),
      };
    },
  };
}

function toEntry(e, projectId) {
  const labels = e.resource?.labels ?? {};
  const name =
    labels.cluster_name && labels.pod_name
      ? `${labels.cluster_name}/${labels.namespace_name}/${labels.pod_name}`
      : (labels.cluster_name ??
        labels.database_id?.split(':').pop() ??
        labels.instance_id ??
        labels.service_name ??
        labels.function_name ??
        null);
  return {
    timestamp: e.timestamp,
    severity: e.severity ?? 'DEFAULT',
    projectId,
    log: logName(e.logName),
    resource: { type: e.resource?.type, name },
    message: text(message(e))?.slice(0, MESSAGE_CHARS) ?? null,
    ...(e.protoPayload ? { audit: audit(e.protoPayload) } : {}),
    ...(e.jsonPayload?.reason ? { reason: text(e.jsonPayload.reason) } : {}),
  };
}

// "projects/p/logs/cloudaudit.googleapis.com%2Factivity" -> "cloudaudit.googleapis.com/activity".
// A log name with a broken % sequence is shown as-is rather than failing the whole query.
function logName(full) {
  const short = (full ?? '').split('/logs/').pop();
  try {
    return decodeURIComponent(short);
  } catch {
    return short;
  }
}

function message(e) {
  if (e.textPayload) return e.textPayload;
  const j = e.jsonPayload;
  if (j) {
    if (j.reason && j.message) return `${text(j.reason)}: ${text(j.message)}`;
    return j.message ?? j.MESSAGE ?? j.msg ?? j.error ?? JSON.stringify(j);
  }
  if (e.protoPayload) return e.protoPayload.status?.message ?? e.protoPayload.methodName;
  return null;
}

// Structured logs often put an object where a string is expected.
const text = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

function audit(p) {
  return {
    method: p.methodName,
    principal: p.authenticationInfo?.principalEmail ?? null,
    resource: p.resourceName,
    ...(p.status?.code ? { status: p.status.message ?? p.status.code } : {}),
  };
}

// Keys are log text (severity, resource names): count in a Map, not an object.
function countBy(list, fn) {
  const out = new Map();
  for (const x of list) tally(out, fn(x));
  return fromMap(out);
}

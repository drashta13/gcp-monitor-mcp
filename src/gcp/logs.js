import { perProject, projectNotes } from './util.js';

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
    async query({ projectIds, preset, filter, hours = 24, limit = 50, resourceName }) {
      const ids = await scope(projectIds);
      const since = new Date(now() - hours * 3600_000).toISOString();
      const parts = [
        `timestamp>="${since}"`,
        preset ? PRESETS[preset] : null,
        filter ? `(${filter})` : null,
        // Plain name match anywhere in the resource labels, e.g. a cluster, instance or service name.
        resourceName ? `"${resourceName.replaceAll('"', '')}"` : null,
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

      const entries = result.ok
        .flatMap(({ projectId, items }) => items.map((e) => toEntry(e, projectId)))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);

      return {
        filter: fullFilter,
        window: { hours, since },
        returned: entries.length,
        truncated: result.ok.some((r) => r.truncated) || entries.length >= limit,
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
    log: decodeURIComponent((e.logName ?? '').split('/logs/').pop()),
    resource: { type: e.resource?.type, name },
    message: message(e)?.slice(0, MESSAGE_CHARS) ?? null,
    ...(e.protoPayload ? { audit: audit(e.protoPayload) } : {}),
    ...(e.jsonPayload?.reason ? { reason: e.jsonPayload.reason } : {}),
  };
}

function message(e) {
  if (e.textPayload) return e.textPayload;
  const j = e.jsonPayload;
  if (j) {
    if (j.reason && j.message) return `${j.reason}: ${j.message}`;
    return j.message ?? j.MESSAGE ?? j.msg ?? j.error ?? JSON.stringify(j);
  }
  if (e.protoPayload) return e.protoPayload.status?.message ?? e.protoPayload.methodName;
  return null;
}

function audit(p) {
  return {
    method: p.methodName,
    principal: p.authenticationInfo?.principalEmail ?? null,
    resource: p.resourceName,
    ...(p.status?.code ? { status: p.status.message ?? p.status.code } : {}),
  };
}

function countBy(list, fn) {
  const out = {};
  for (const x of list) out[fn(x)] = (out[fn(x)] ?? 0) + 1;
  return out;
}

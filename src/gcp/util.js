import { ConfigError } from './billing.js';

// Like Promise.allSettled, but runs at most `limit` tasks at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Resolves which projects a call covers: the requested ones (checked against the allowlist), else the
// allowlist, else every project the identity can see.
export function createProjectScope({ allowedProjects }, projects) {
  return async (projectIds = []) => {
    if (allowedProjects.length) {
      const denied = projectIds.filter((p) => !allowedProjects.includes(p));
      if (denied.length) throw new ConfigError(`Projects not in GCP_MONITOR_ALLOWED_PROJECTS: ${denied.join(', ')}`);
      return projectIds.length ? projectIds : allowedProjects;
    }
    if (projectIds.length) return projectIds;
    return (await projects.list()).map((p) => p.projectId);
  };
}

// Runs fn per project. Projects that fail are reported instead of sinking the call, unless all fail.
export async function perProject(ids, concurrency, fn) {
  const results = await mapLimit(ids, concurrency, fn);
  const ok = [];
  const failed = [];
  // A project where the service's API was never enabled simply doesn't use that service: not a failure.
  const apiNotEnabled = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok.push(r.value);
    else if (isApiDisabled(r.reason)) apiNotEnabled.push(ids[i]);
    else failed.push({ projectId: ids[i], error: r.reason?.message ?? String(r.reason) });
  });
  if (ids.length && failed.length === ids.length) throw results.find((r) => r.status === 'rejected').reason;
  return { ok, failed, apiNotEnabled };
}

export const isApiDisabled = (err) =>
  /SERVICE_DISABLED|API has not been used in project|API .* is disabled/.test(err?.message ?? '');

// Spread into a tool result: failed projects and projects that don't use the service.
export const projectNotes = ({ failed = [], apiNotEnabled = [] }) => ({
  ...(apiNotEnabled.length ? { apiNotEnabledIn: apiNotEnabled } : {}),
  ...(failed.length ? { failedProjects: failed } : {}),
});

export const round = (n, digits = 2) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

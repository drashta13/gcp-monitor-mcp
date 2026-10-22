import { ConfigError } from './errors.js';

// Like Promise.allSettled, but runs at most `limit` tasks at once. A synchronous throw from fn counts
// as a rejection too.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await Promise.resolve()
        .then(() => fn(items[i]))
        .then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }),
        );
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Google Cloud project IDs: lowercase letters, digits and hyphens, starting with a letter, at most 30
// characters, not ending in a hyphen. Checked before an ID is used in a URL or a report scope, so a
// crafted ID can't change which path an authenticated request goes to.
export const PROJECT_ID_RE = /^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

// The single allowlist check: validates the requested IDs, drops duplicates, and refuses anything not in
// GCP_MONITOR_ALLOWED_PROJECTS when one is set. Returns the (deduplicated) requested IDs.
export function checkProjectIds(projectIds = [], allowedProjects = []) {
  const ids = [...new Set(projectIds)];
  const invalid = ids.filter((id) => typeof id !== 'string' || !PROJECT_ID_RE.test(id));
  if (invalid.length) throw new ConfigError(`Not a valid project ID: ${invalid.map(String).join(', ')}`);
  if (allowedProjects.length) {
    const denied = ids.filter((p) => !allowedProjects.includes(p));
    if (denied.length) throw new ConfigError(`Projects not in GCP_MONITOR_ALLOWED_PROJECTS: ${denied.join(', ')}`);
  }
  return ids;
}

// Resolves which projects a call covers: the requested ones (checked against the allowlist), else the
// allowlist, else every project the identity can see.
export function createProjectScope({ allowedProjects }, projects) {
  return async (projectIds) => {
    const ids = checkProjectIds(projectIds, allowedProjects);
    if (ids.length) return ids;
    if (allowedProjects.length) return allowedProjects;
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

// Counts by key into a Map. Keys often come from Google (cluster names, log fields, policy names), and
// a plain object keyed by remote text is open to prototype pollution ("__proto__", "constructor").
export function tally(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
  return map;
}

// Map -> plain object for the JSON result. Object.fromEntries defines own properties, so a "__proto__"
// key becomes an ordinary field rather than touching the prototype.
export const fromMap = (map) => Object.fromEntries(map);

// Today's date, YYYY-MM-DD, in the given IANA time zone.
export const dateIn = (timeZone, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);

// The instant (epoch ms) of 00:00 on `date` (YYYY-MM-DD) in the given time zone. Iterates on the zone's
// wall clock, so it is right on daylight-saving switch days too.
export function zonedMidnight(date, timeZone) {
  const wanted = Date.parse(`${date}T00:00:00Z`); // the wall-clock time we want, as a UTC number
  let instant = wanted;
  for (let i = 0; i < 3; i++) instant -= wallClock(instant, timeZone) - wanted;
  return instant;
}

// One calendar day in a time zone as a [start, end) window. 23 or 25 hours long on DST switch days.
export function dayWindow(date, timeZone) {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const start = zonedMidnight(date, timeZone);
  const end = zonedMidnight(next, timeZone);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), hours: Math.round((end - start) / 3_600_000) };
}

// Wall-clock reading of an instant in a time zone, expressed as a UTC timestamp of the same digits.
function wallClock(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return Date.UTC(+g.year, g.month - 1, +g.day, +g.hour, +g.minute, +g.second);
}

// Metrics of resources that are no longer in the configuration list (deleted since the window): kept, so a
// past day's history isn't missing them. Keys are "project/name".
export function metricsWithoutResource(metricsByName, seen) {
  return [...metricsByName]
    .filter(([key]) => !seen.has(key))
    .map(([key, metrics]) => {
      const i = key.indexOf('/');
      return { name: key.slice(i + 1), projectId: key.slice(0, i), metrics };
    });
}

// End of a look-back window: the given ISO time, or now. Returns epoch ms.
export function windowEnd(endTime, now = Date.now) {
  if (endTime == null) return now();
  const t = Date.parse(endTime);
  if (!Number.isFinite(t)) throw new ConfigError(`endTime "${endTime}" is not a valid ISO 8601 time`);
  return t;
}

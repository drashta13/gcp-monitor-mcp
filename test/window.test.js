import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedMidnight, dayWindow, windowEnd, createProjectScope } from '../src/gcp/util.js';
import { pacificMidnight } from '../src/gcp/appoptimize.js';
import { createIncidentsService } from '../src/gcp/incidents.js';
import { createLogsService } from '../src/gcp/logs.js';
import { createGkeHealthService } from '../src/gcp/gkehealth.js';
import { createUsageService, USAGE } from '../src/gcp/metrics.js';
import { createSqlHealthService } from '../src/gcp/sqlhealth.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const scope = createProjectScope({ allowedProjects: ['p'] }, { list: async () => [] });

function fakeRest(routes) {
  const calls = [];
  const respond = async (url, params) => (calls.push({ url, params }), routes(url, params ?? {}));
  return {
    calls,
    get: (url, params) => respond(url, params),
    post: (url, data) => respond(url, data),
    async list(url, { params = {}, key, max = 1000 } = {}) {
      const data = await respond(url, params);
      return { items: (data?.[key] ?? []).slice(0, max), truncated: false };
    },
  };
}

test('zonedMidnight and dayWindow follow the zone, including DST switch days', () => {
  assert.equal(new Date(zonedMidnight('2026-10-12', 'America/Los_Angeles')).toISOString(), '2026-10-12T07:00:00.000Z');
  assert.equal(new Date(zonedMidnight('2026-12-12', 'America/Los_Angeles')).toISOString(), '2026-12-12T08:00:00.000Z');
  assert.equal(new Date(zonedMidnight('2026-10-12', 'Asia/Kolkata')).toISOString(), '2026-10-11T18:30:00.000Z');
  assert.equal(new Date(zonedMidnight('2026-10-12', 'UTC')).toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(dayWindow('2026-11-01', 'America/Los_Angeles').hours, 25); // fall back
  assert.equal(dayWindow('2026-03-08', 'America/Los_Angeles').hours, 23); // spring forward
  assert.deepEqual(dayWindow('2026-10-12', 'America/Los_Angeles'), {
    start: '2026-10-12T07:00:00.000Z',
    end: '2026-10-13T07:00:00.000Z',
    hours: 24,
  });
  // Agrees with the App Optimize helper.
  for (const d of ['2026-03-08', '2026-03-09', '2026-11-01', '2026-11-02', '2026-07-04']) {
    assert.equal(zonedMidnight(d, 'America/Los_Angeles'), Date.parse(pacificMidnight(d)), d);
  }
  assert.equal(windowEnd(undefined, () => 5), 5);
  assert.throws(() => windowEnd('not a time'), /not a valid ISO 8601/);
});

test('incidents with endTime: alerts overlapping the window, bounded server filter', async () => {
  const rest = fakeRest((url) => {
    if (url.includes('/alerts'))
      return {
        alerts: [
          { name: 'a1', state: 'CLOSED', openTime: '2026-10-11T23:00:00Z', closeTime: '2026-10-12T01:00:00Z', policy: { displayName: 'spans start' } },
          { name: 'a2', state: 'CLOSED', openTime: '2026-10-12T10:00:00Z', closeTime: '2026-10-12T10:30:00Z', policy: { displayName: 'inside' } },
          { name: 'a3', state: 'CLOSED', openTime: '2026-10-11T10:00:00Z', closeTime: '2026-10-11T11:00:00Z', policy: { displayName: 'before' } },
          { name: 'a4', state: 'OPEN', openTime: '2026-10-10T10:00:00Z', policy: { displayName: 'still open' } },
        ],
      };
    return { events: [] };
  });
  const usage = { usage: async (args) => ((usage.args = args), { resources: [] }) };
  const svc = createIncidentsService({ scope, rest, usage, now: () => NOW });
  const out = await svc.incidents({ hours: 24, endTime: '2026-10-13T00:00:00Z' });
  assert.deepEqual(out.incidents.map((a) => a.policy).sort(), ['inside', 'spans start', 'still open']);
  assert.deepEqual(out.window, { hours: 24, since: '2026-10-12T00:00:00.000Z', until: '2026-10-13T00:00:00.000Z' });
  const filter = rest.calls.find((c) => c.url.includes('/alerts')).params.filter;
  assert.equal(filter, '(state="OPEN" OR close_time>="2026-10-12T00:00:00Z") AND open_time<="2026-10-12T23:59:59Z"');
  // Minutes are clipped to the day; "open" means open when the day ended.
  const byName = Object.fromEntries(out.incidents.map((a) => [a.policy, a]));
  assert.equal(byName['spans start'].minutesInWindow, 60);
  assert.equal(byName['spans start'].openAtWindowEnd, false);
  assert.equal(byName['still open'].minutesInWindow, 1440);
  assert.equal(byName['still open'].openAtWindowEnd, true);
  assert.equal(out.summary.open, 1);
  assert.equal(out.byPolicy.find((p) => p.policy === 'inside').totalMinutes, 30);
  assert.equal(usage.args.endTime, '2026-10-13T00:00:00Z');
});

test('query_logs and GKE log counts bound the window when endTime is given', async () => {
  const rest = fakeRest(() => ({ entries: [], clusters: [] }));
  const logs = createLogsService({ scope, rest, now: () => NOW });
  const out = await logs.query({ preset: 'errors', hours: 24, endTime: '2026-10-13T07:00:00Z' });
  assert.equal(out.filter, 'timestamp>="2026-10-12T07:00:00.000Z" AND timestamp<"2026-10-13T07:00:00.000Z" AND severity>=ERROR');
  assert.equal(out.window.until, '2026-10-13T07:00:00.000Z');

  const rest2 = fakeRest(() => ({ entries: [], clusters: [] }));
  const usage = { usage: async () => ({ resources: [] }) };
  await createGkeHealthService({ scope, rest: rest2, usage, now: () => NOW }).health({ hours: 24, endTime: '2026-10-13T07:00:00Z' });
  const filters = rest2.calls.map((c) => c.params?.filter).filter(Boolean);
  assert.equal(filters.length, 2);
  for (const f of filters) assert.match(f, /timestamp>="2026-10-12T07:00:00.000Z" AND timestamp<"2026-10-13T07:00:00.000Z"/);
});

test('usage with endTime asks Monitoring for that interval; logs kind counts warning-or-worse entries', async () => {
  const calls = [];
  const client = {
    listTimeSeries: async (req) => {
      calls.push(req);
      return [
        [
          {
            resource: { labels: {}, type: 'k8s_container' },
            metric: { labels: { severity: 'ERROR' } },
            points: [{ value: { int64Value: '4' } }, { value: { int64Value: '6' } }],
          },
        ],
      ];
    },
  };
  const svc = createUsageService({ scope }, client, () => NOW);
  const out = await svc.usage({ kind: 'logs', hours: 24, endTime: '2026-10-13T07:00:00Z' });
  assert.equal(calls[0].interval.endTime.seconds, Date.parse('2026-10-13T07:00:00Z') / 1000);
  assert.equal(calls[0].interval.startTime.seconds, Date.parse('2026-10-12T07:00:00Z') / 1000);
  assert.match(calls[0].filter, /logging\.googleapis\.com\/log_entry_count/);
  assert.match(calls[0].filter, /one_of\("WARNING", "ERROR"/);
  assert.equal(out.resources[0].name, 'k8s_container');
  assert.equal(out.resources[0].severity, 'ERROR');
  assert.deepEqual(out.resources[0].metrics.entries, { total: 10 });
  assert.deepEqual(USAGE.logs.groupBy, ['resource.type', 'metric.label.severity']);
});

test('incidents with endTime keep only Google Cloud events that overlapped the window', async () => {
  const rest = fakeRest((url) =>
    url.includes('/alerts')
      ? { alerts: [] }
      : {
          events: [
            // Closed long before the day, but Google edited it during the day: not part of the day.
            { title: 'old', state: 'CLOSED', startTime: '2026-10-01T12:00:00Z', endTime: '2026-10-01T17:00:00Z', updateTime: '2026-10-12T09:00:00Z' },
            { title: 'during', state: 'CLOSED', startTime: '2026-10-12T10:00:00Z', endTime: '2026-10-12T11:00:00Z', updateTime: '2026-10-12T11:00:00Z' },
            { title: 'ongoing', state: 'ACTIVE', startTime: '2026-10-11T10:00:00Z', updateTime: '2026-10-11T10:00:00Z' },
            { title: 'later', state: 'ACTIVE', startTime: '2026-10-13T10:00:00Z', updateTime: '2026-10-13T10:00:00Z' },
            // No start or end time (seen live): only the day of its last update counts.
            { title: 'timeless old', state: 'CLOSED', updateTime: '2026-10-05T10:00:00Z' },
            { title: 'timeless during', state: 'CLOSED', updateTime: '2026-10-12T15:00:00Z' },
          ],
        },
  );
  const usage = { usage: async () => ({ resources: [] }) };
  const out = await createIncidentsService({ scope, rest, usage, now: () => NOW }).incidents({ hours: 24, endTime: '2026-10-13T00:00:00Z' });
  assert.deepEqual(out.googleCloudEvents.map((e) => e.title).sort(), ['during', 'ongoing', 'timeless during']);
});

test('health for a past window: resources created later are left out, deleted ones keep their metrics', async () => {
  const rest = fakeRest((url) => {
    if (url.endsWith('/projects/p/instances'))
      return {
        items: [
          { name: 'old-db', state: 'RUNNABLE', createTime: '2026-01-01T00:00:00Z', settings: { deletionProtectionEnabled: true } },
          { name: 'new-db', state: 'RUNNABLE', createTime: '2026-10-14T00:00:00Z', settings: { deletionProtectionEnabled: true } },
        ],
      };
    return { items: [] };
  });
  let usageArgs;
  const usage = {
    usage: async (args) => (
      (usageArgs = args),
      {
        resources: [
          { name: 'old-db', projectId: 'p', metrics: { cpuPercent: { avg: 10 } } },
          { name: 'dropped-db', projectId: 'p', metrics: { cpuPercent: { avg: 55 } } },
        ],
      }
    ),
  };
  const svc = createSqlHealthService({ scope, rest, usage, now: () => NOW });
  const out = await svc.health({ hours: 24, endTime: '2026-10-13T00:00:00Z' });
  assert.deepEqual(out.instances.map((i) => i.name), ['old-db']);
  assert.deepEqual(out.notFoundNow, [{ name: 'dropped-db', projectId: 'p', metrics: { cpuPercent: { avg: 55 } } }]);
  assert.equal(usageArgs.limit, Infinity); // every instance's metrics, not the 200 busiest
  // Live (no endTime): today's list, nothing extra.
  const live = await svc.health({ hours: 24 });
  assert.deepEqual(live.instances.map((i) => i.name).sort(), ['new-db', 'old-db']);
  assert.equal(live.notFoundNow, undefined);
});

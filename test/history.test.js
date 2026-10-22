import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openHistoryDb, SCHEMA_VERSION } from '../src/history/db.js';
import { createHistoryStore, fingerprint } from '../src/history/store.js';
import { createCaptureService, extractFindings, extractMetrics, severityOf, anomalyFinding, SECTIONS } from '../src/history/capture.js';
import { createServer } from '../src/server.js';
import { ConfigError } from '../src/gcp/errors.js';
import { loadConfig } from '../src/config.js';

const parse = (res) => JSON.parse(res.content[0].text);

// Fake cost source shaped like the BigQuery billing service (UTC days).
function fakeBilling({ total = 100, comparison, perService } = {}) {
  const services = perService ?? { 'Compute Engine': total * 0.7, 'Cloud SQL': total * 0.3 };
  const calls = [];
  return {
    calls,
    timezone: 'UTC',
    summary: async (args) => {
      calls.push({ method: 'summary', ...args });
      const { groupBy, startDate } = args;
      const rows = {
        service: Object.entries(services).map(([service, netCost]) => ({ service, netCost, currency: 'USD' })),
        project: [{ project: 'p', netCost: total, currency: 'USD' }],
        sku: [{ sku: 'Compute Engine / N2 Core', netCost: total * 0.5, currency: 'USD' }],
        region: [{ region: 'us-central1', netCost: total, currency: 'USD' }],
      }[groupBy];
      return { startDate, groupBy, totals: { USD: { netCost: total, groups: rows.length } }, rows };
    },
    trend: async (args) => (calls.push({ method: 'trend', ...args }), { points: [{ period: args.endDate, netCost: total, currency: 'USD' }] }),
    topResources: async (args) => (
      calls.push({ method: 'topResources', ...args }),
      { rows: [{ resource: '//compute/vm-1', service: 'Compute Engine', projectId: 'p', netCost: total * 0.4, currency: 'USD' }] }
    ),
    comparison: async () => {
      if (!comparison) throw new ConfigError('get_cost_comparison currently runs on the App Optimize source only.');
      return comparison;
    },
  };
}

function fakeHealth({ diskPercent = 91, vmIssues = ['disk 91% full'], openAlert = true, sqlFails = false, vmFails = false, calls = [] } = {}) {
  return {
    cloudsql: {
      health: async (args) => {
        calls.push({ service: 'cloudsql', ...args });
        if (sqlFails) throw new Error('SQL Admin API boom');
        return {
          summary: { instances: 1, withIssues: 1 },
          instances: [
            {
              name: 'db-1',
              projectId: 'p',
              metrics: { cpuPercent: { avg: 40, max: 70, latest: 35 } },
              issues: ['point-in-time recovery is off', 'deletion protection is off'],
            },
          ],
        };
      },
    },
    vm: {
      health: async (args) => {
        if (vmFails) throw new Error('Compute API 503');
        return (
        calls.push({ service: 'vm', ...args }),
        {
          summary: { vms: 1, withIssues: vmIssues.length },
          vms: [{ name: 'vm-1', projectId: 'p', metrics: { diskPercent: { avg: diskPercent, max: diskPercent, latest: diskPercent } }, issues: vmIssues }],
          unattachedDisks: [],
        }
      );
      },
    },
    gke: {
      health: async () => ({
        summary: { clusters: 1, withIssues: 0 },
        clusters: [{ name: 'prod', projectId: 'p', events: { OOMKilling: 2 }, autoscaling: { scaleUp: 3 }, metrics: {}, issues: [] }],
      }),
    },
    incidents: {
      incidents: async (args) => (
        calls.push({ service: 'incidents', ...args }),
        {
          summary: { incidents: openAlert ? 1 : 0, open: openAlert ? 1 : 0 },
          byPolicy: openAlert ? [{ policy: 'High 5xx', count: 1, open: 1, totalMinutes: 30 }] : [],
          incidents: openAlert
            ? [{ policy: 'High 5xx', state: 'OPEN', openTime: '2026-10-12T10:00:00Z', durationMinutes: 30, projectId: 'p', resource: { type: 'cloud_run_revision', name: 'web' } }]
            : [],
          googleCloudEvents: [],
          availability: [{ name: 'home', projectId: 'p', metrics: { availabilityPercent: { avg: 98.5 } } }],
        }
      ),
    },
    logs: {
      query: async ({ preset }) => {
        if (preset === 'autoscaler') throw new Error('logs boom');
        return { returned: preset === 'errors' ? 7 : 0, entries: [] };
      },
    },
  };
}

const fakeUsage = () => ({
  usage: async ({ kind }) => ({
    kind,
    resources:
      kind === 'gke'
        ? [{ name: 'prod', namespace: 'web', projectId: 'p', metrics: { cpuCores: { avg: 1.5, max: 2, latest: 1 }, containerRestarts: { total: 4 } } }]
        : kind === 'cloudrun'
          ? [{ name: 'api', projectId: 'p', metrics: { requestsPerSec: { avg: 12, max: 30, latest: 10 } } }]
          : [{ name: 'k8s_container', severity: 'ERROR', projectId: 'p', metrics: { entries: { total: 42 } } }],
  }),
});

const fakeInventory = () => ({
  list: async () => ({
    resources: [
      { kind: 'vm', projectId: 'p', name: 'vm-1', active: true },
      { kind: 'vm', projectId: 'p', name: 'vm-2', active: false },
      { kind: 'bucket', projectId: 'p', name: 'b', active: true },
    ],
  }),
});

function setup({ day = '2026-10-14', billing = fakeBilling(), health = fakeHealth() } = {}) {
  let now = new Date(`${day}T12:00:00Z`);
  const clock = () => now;
  const db = openHistoryDb(':memory:');
  const store = createHistoryStore(db, { now: clock });
  const make = (b, h) => createCaptureService({ billing: b, health: h, usage: fakeUsage(), inventory: fakeInventory(), store, now: clock });
  const capture = make(billing, health);
  return {
    db,
    store,
    capture,
    setDay: (d) => (now = new Date(`${d}T12:00:00Z`)),
    setServices: (b, h) => Object.assign(capture, make(b, h)),
  };
}

test('migrations create the schema once; reopening a file is a no-op and the file is private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcpmon-'));
  try {
    const path = join(dir, 'sub', 'history.db');
    const db = openHistoryDb(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    db.close();
    const again = openHistoryDb(path);
    const tables = again.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);
    assert.deepEqual(tables, ['events', 'findings', 'metrics', 'reports', 'snapshot_results', 'snapshots']);
    const cols = again.prepare('PRAGMA table_info(snapshots)').all().map((c) => c.name);
    assert.ok(cols.includes('window_start') && cols.includes('window_end'));
    again.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'sub')).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture covers one whole day: every section gets that day, metrics are keyed by it', async () => {
  const calls = [];
  const billing = fakeBilling();
  const { store, capture } = setup({ billing, health: fakeHealth({ sqlFails: true, calls }) });
  const out = await capture.capture();

  assert.equal(out.day, '2026-10-12');
  assert.deepEqual(out.window, { start: '2026-10-12T00:00:00.000Z', end: '2026-10-13T00:00:00.000Z', hours: 24 });
  assert.deepEqual(Object.keys(out.sections), SECTIONS);
  assert.equal(out.sections.cloudsql, 'error');
  assert.equal(out.sections.vm, 'ok');
  assert.equal(out.sections.costComparison, 'skipped'); // BigQuery source: not an error
  assert.equal(out.sections.logs, 'partial'); // one preset failing: data kept, but incomplete
  assert.match(out.errors.find((e) => e.section === 'cloudsql').error, /SQL Admin API boom/);
  assert.match(out.errors.find((e) => e.section === 'logs').presetErrors.autoscaler, /logs boom/);

  // Health, incidents and logs all asked for the same 24 hours.
  for (const c of calls) {
    assert.equal(c.endTime, '2026-10-13T00:00:00.000Z', c.service);
    assert.equal(c.hours, 24, c.service);
  }
  assert.ok(billing.calls.filter((c) => c.method === 'summary').every((c) => c.startDate === '2026-10-12' && c.endDate === '2026-10-12'));
  assert.deepEqual(new Set(billing.calls.filter((c) => c.method === 'summary').map((c) => c.groupBy)), new Set(['service', 'project', 'sku', 'region']));

  assert.equal(out.cost.total, 100);
  assert.deepEqual(out.cost.topServices[0], { service: 'Compute Engine', cost: 70 });
  assert.equal(out.sinceLastSnapshot, 'first snapshot: nothing to compare with yet');

  const raw = store.getSnapshot({ snapshotId: out.snapshotId, section: 'vm' });
  assert.equal(raw.result.vms[0].name, 'vm-1');
  const disk = store.metricSeries({ metric: 'diskPercent.latest', kind: 'vm' });
  assert.deepEqual(disk.series[0].points, [{ date: '2026-10-12', value: 91 }]);

  const kinds = new Set(store.metricSeries({}).available.map((a) => `${a.kind}:${a.metric}`));
  for (const k of [
    'cost_sku:dailyCost',
    'cost_region:dailyCost',
    'cost_resource:dailyCost',
    'gke_namespace:containerRestarts.total',
    'gke:events.OOMKilling',
    'gke:autoscaler.scaleUp',
    'cloudrun:requestsPerSec.avg',
    'logs:entries.total',
    'log_preset:entries',
    'inventory:active',
    'uptime:availabilityPercent.avg',
    'incidents:minutes',
  ]) {
    assert.ok(kinds.has(k), k);
  }
  const res = store.metricSeries({ metric: 'dailyCost', kind: 'cost_resource' }).series[0];
  assert.equal(res.projectId, 'p');
  const titles = store.getSnapshot({ snapshotId: out.snapshotId }).findings.map((f) => f.title);
  assert.ok(titles.includes('uptime check below 100%'));
});

test('capture refuses a day that is not over yet', async () => {
  const { capture } = setup();
  await assert.rejects(capture.capture({ day: '2026-10-14' }), /not over yet/);
  await assert.rejects(capture.capture({ day: '2026-10-20' }), ConfigError);
});

test('a second day reports new, resolved and persisting findings; numbers do not break matching', async () => {
  const { store, capture, setDay, setServices } = setup();
  await capture.capture();
  setDay('2026-10-15');
  setServices(fakeBilling({ total: 150 }), fakeHealth({ diskPercent: 94, vmIssues: ['disk 94% full', 'CPU averaging 85%'], openAlert: false }));
  const out = await capture.capture();

  assert.equal(out.sinceLastSnapshot.comparedWith, '2026-10-12');
  assert.deepEqual(out.sinceLastSnapshot.new.map((f) => f.title), ['CPU averaging 85%']);
  assert.deepEqual(out.sinceLastSnapshot.resolved.map((f) => f.title), ['alert: High 5xx']);

  const diff = store.diff({});
  assert.equal(diff.from.date, '2026-10-12');
  assert.equal(diff.to.date, '2026-10-13');
  assert.equal(diff.metricChanges.find((m) => m.metric === 'diskPercent.latest'), undefined); // 91 -> 94 is under 20%
  assert.ok(diff.metricChanges.some((m) => m.kind === 'incidents' && m.metric === 'open' && m.after === 0));

  const full = store.searchFindings({ category: 'vm' }).findings.find((f) => /full/.test(f.title));
  assert.equal(full.title, 'disk 94% full'); // latest wording
  assert.equal(full.firstSeen, '2026-10-12');
  assert.equal(full.lastSeen, '2026-10-13');
  assert.equal(full.daysSeen, 2);
  assert.equal(full.openNow, true);
  assert.equal(store.searchFindings({ category: 'incident', text: '5xx' }).findings[0].openNow, false);
});

test('capturing a day again replaces it, and reports that cited it follow', async () => {
  const { store, capture, setServices } = setup();
  const first = await capture.capture({ sections: ['cost'] });
  const reportId = store.saveReport({ date: '2026-10-12', kind: 'daily', title: 't', summary: 's', bodyMarkdown: 'b', snapshotId: first.snapshotId, tags: [] });
  setServices(fakeBilling({ total: 120 }), fakeHealth());
  const second = await capture.capture({ sections: ['cost'] });

  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal(store.list({ type: 'snapshots' }).snapshots.length, 1);
  assert.equal(store.getReport({ reportId }).snapshotId, second.snapshotId);
  assert.deepEqual(store.metricSeries({ metric: 'dailyCost', kind: 'cost_total' }).series[0].points, [{ date: '2026-10-12', value: 120 }]);
});

test('re-running one failed section keeps the rest of the day', async () => {
  const { store, capture, setServices } = setup({ health: fakeHealth({ sqlFails: true }) });
  const first = await capture.capture();
  assert.equal(first.sections.cloudsql, 'error');
  const vmFindings = store.getSnapshot({ snapshotId: first.snapshotId }).findings.filter((f) => f.category === 'vm').length;

  setServices(fakeBilling(), fakeHealth());
  const retry = await capture.capture({ sections: ['cloudsql'] });
  assert.deepEqual(retry.ranThisTime, ['cloudsql']);
  assert.equal(retry.sections.cloudsql, 'ok');
  assert.equal(retry.sections.vm, 'ok'); // kept from the first capture
  assert.equal(retry.sections.costComparison, 'skipped');
  assert.equal(retry.cost.total, 100); // cost headline kept although cost didn't run again
  assert.equal(retry.cost.topServices[0].service, 'Compute Engine');

  const snap = store.getSnapshot({ snapshotId: retry.snapshotId });
  assert.equal(store.list({ type: 'snapshots' }).snapshots.length, 1);
  assert.equal(snap.findings.filter((f) => f.category === 'vm').length, vmFindings);
  assert.ok(snap.findings.some((f) => f.category === 'cloudsql'));
  assert.ok(!snap.errors.some((e) => e.section === 'cloudsql'));
  assert.ok(snap.errors.some((e) => e.section === 'costComparison' && e.skipped));
  assert.equal(store.getSnapshot({ snapshotId: retry.snapshotId, section: 'vm' }).result.vms[0].name, 'vm-1');
  assert.equal(store.getSnapshot({ snapshotId: retry.snapshotId, section: 'cloudsql' }).result.instances[0].name, 'db-1');
  const total = snap.summary.findings.high + snap.summary.findings.medium + snap.summary.findings.low;
  assert.equal(total, snap.findings.length);
});

test('backfilling an older day after a newer one compares by day, not by capture order', async () => {
  const { store, capture } = setup();
  await capture.capture({ day: '2026-10-12', sections: ['vm'] });
  const old = await capture.capture({ day: '2026-10-10', sections: ['vm'] });
  assert.equal(old.sinceLastSnapshot, 'first snapshot: nothing to compare with yet');
  assert.equal(store.getSnapshot({ snapshotId: 'latest' }).date, '2026-10-12');
  assert.deepEqual(store.missingDays('2026-10-09', '2026-10-12'), ['2026-10-09', '2026-10-11']);
  const mid = await capture.capture({ day: '2026-10-11', sections: ['vm'] });
  assert.equal(mid.sinceLastSnapshot.comparedWith, '2026-10-10');
});

test('missingDays in the capture result lists recent days with no snapshot', async () => {
  const { capture } = setup();
  const out = await capture.capture({ sections: ['vm'] });
  assert.equal(out.missingDays.length, 26); // 2026-09-16 .. 2026-10-11
  assert.equal(out.missingDays[0], '2026-09-16');
  assert.ok(!out.missingDays.includes('2026-10-12'));
  assert.match(out.nextStep, /Capture the missing days/);
});

test('find_anomalies: spikes, drops, new and stopped cost lines, missing resources, noise floors', () => {
  const store = createHistoryStore(openHistoryDb(':memory:'), { now: () => new Date('2026-10-20T00:00:00Z') });
  const days = Array.from({ length: 15 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const metrics = [];
  days.forEach((date, i) => {
    const last = i === days.length - 1;
    metrics.push({ date, kind: 'cost_total', resource: 'total', metric: 'dailyCost', value: 1000 + (i % 2) * 10, unit: 'USD' });
    metrics.push({ date, kind: 'cost_service', resource: 'BigQuery', metric: 'dailyCost', value: last ? 400 : 100 + (i % 3), unit: 'USD' });
    metrics.push({ date, kind: 'cost_service', resource: 'Tiny', metric: 'dailyCost', value: last ? 0.9 : 0.1 }); // +800% but under the floor
    if (!last) metrics.push({ date, kind: 'cost_service', resource: 'Retired', metric: 'dailyCost', value: 50, unit: 'USD' });
    if (last) metrics.push({ date, kind: 'cost_service', resource: 'Brand new', metric: 'dailyCost', value: 30, unit: 'USD' });
    // A metric that only exists on the last day of a kind with history (seen live): not "new" spend.
    if (last) metrics.push({ date, kind: 'cost_total', resource: 'total', metric: 'weekPerDay', value: 900, unit: 'USD' });
    metrics.push({ date, kind: 'vm', projectId: 'p', resource: 'vm-1', metric: 'cpuPercent.avg', value: last ? 10 : 60 + (i % 2) });
    metrics.push({ date, kind: 'vm', projectId: 'p', resource: 'vm-2', metric: 'cpuPercent.avg', value: last ? 3 : 1 }); // under 5 points
    if (!last) metrics.push({ date, kind: 'vm', projectId: 'p', resource: 'vm-gone', metric: 'cpuPercent.avg', value: 20 });
    if (!last) metrics.push({ date, kind: 'vm', projectId: 'p', resource: 'vm-gone', metric: 'diskPercent.latest', value: 50 });
  });
  for (const date of days) {
    store.saveSnapshot({
      date,
      projects: [],
      sections: [],
      errors: [],
      summary: { sections: { cost: 'ok', vm: 'ok' } },
      results: [],
      metrics: metrics.filter((m) => m.date === date),
      findings: [],
    });
  }
  const out = store.anomalies({});
  assert.equal(out.date, '2026-10-15');
  const by = (resource) => out.anomalies.filter((a) => a.resource === resource);
  assert.equal(by('BigQuery')[0].type, 'spike');
  assert.equal(by('BigQuery')[0].baselineDays, 14);
  assert.equal(by('Tiny').length, 0);
  assert.equal(by('Retired')[0].type, 'stopped');
  assert.equal(by('Brand new')[0].type, 'new');
  assert.ok(!out.anomalies.some((a) => a.metric === 'weekPerDay'));
  assert.equal(by('vm-1')[0].type, 'drop');
  assert.equal(by('vm-2').length, 0);
  assert.equal(by('vm-gone').length, 1); // one row per resource, not per metric
  assert.equal(by('vm-gone')[0].type, 'missing');

  // A section that did not run that day doesn't make its series "missing".
  const db2 = createHistoryStore(openHistoryDb(':memory:'));
  for (const date of days) {
    db2.saveSnapshot({
      date,
      projects: [],
      sections: [],
      errors: [],
      summary: { sections: { vm: date === '2026-10-15' ? 'error' : 'ok' } },
      results: [],
      metrics: metrics.filter((m) => m.date === date && m.kind === 'vm' && m.resource === 'vm-gone'),
      findings: [],
    });
  }
  assert.equal(db2.anomalies({ date: '2026-10-15' }).anomalies.length, 0);

  assert.deepEqual(anomalyFinding(by('BigQuery')[0]).title, 'anomaly: dailyCost spike');
  assert.equal(anomalyFinding(by('BigQuery')[0]).category, 'cost');
  assert.equal(anomalyFinding(by('vm-gone')[0]).title, 'anomaly: stopped reporting');
});

test('cost anomalies from the comparison become findings', () => {
  const out = extractFindings('costComparison', {
    anomalies: [
      { type: 'spike', scope: 'service', name: 'BigQuery', currentPerDay: 40, baselinePerDay: 10, changePct: 300 },
      { type: 'new', scope: 'resource', name: '//run/svc', service: 'Cloud Run', projectId: 'p', currentPerDay: 2, baselinePerDay: 0, changePct: null },
    ],
  });
  assert.equal(out[0].title, 'cost spike: BigQuery');
  assert.equal(out[0].severity, 'medium');
  assert.equal(out[1].title, 'cost new: Cloud Run');
  assert.equal(out[1].resource, '//run/svc');
});

test('extractMetrics keeps App Optimize cost (before credits) and log-volume severities', () => {
  const day = { date: '2026-10-12' };
  const cost = extractMetrics('cost', { byService: { totals: { USD: { cost: 50, groups: 1 } }, rows: [{ service: 'X', cost: 50, currency: 'USD' }] } }, day);
  assert.deepEqual(cost.find((m) => m.kind === 'cost_total'), { date: '2026-10-12', kind: 'cost_total', resource: 'total', metric: 'dailyCost', value: 50, unit: 'USD' });
  const logs = extractMetrics('logVolume', { resources: [{ name: 'gce_instance', severity: 'WARNING', projectId: 'p', metrics: { entries: { total: 9 } } }] }, day);
  assert.equal(logs[0].resource, 'gce_instance/WARNING');
});

test('severity and fingerprint rules', () => {
  assert.equal(severityOf('state is SUSPENDED'), 'high');
  assert.equal(severityOf('status TERMINATED'), 'low');
  assert.equal(severityOf('3 OOM kill event(s)'), 'high');
  assert.equal(severityOf('disk 88% full'), 'medium');
  assert.equal(severityOf('deletion protection is off'), 'low');
  const f = { category: 'vm', projectId: 'p', kind: 'vm', resource: 'a' };
  assert.equal(fingerprint({ ...f, title: 'disk 91% full' }), fingerprint({ ...f, title: 'disk 93.5% full' }));
  assert.notEqual(fingerprint({ ...f, title: 'disk 91% full' }), fingerprint({ ...f, resource: 'b', title: 'disk 91% full' }));
});

test('reports round-trip, list filters by date, and report findings are searchable', async () => {
  const { store, capture } = setup();
  const { snapshotId } = await capture.capture();
  const id = store.saveReport({
    date: '2026-10-12',
    kind: 'daily',
    title: 'Daily check',
    summary: 'All fine apart from vm-1 disk.',
    bodyMarkdown: '# Daily\n\nvm-1 disk is filling up.',
    snapshotId,
    findings: [{ category: 'vm', severity: 'medium', resource: 'vm-1', projectId: 'p', title: 'log rotation missing on vm-1', detail: 'root cause' }],
    tags: ['daily'],
  });
  store.saveReport({ date: '2026-09-01', kind: 'adhoc', title: 'Old', summary: 's', bodyMarkdown: 'b', tags: [] });

  const report = store.getReport({ reportId: id });
  assert.equal(report.bodyMarkdown, '# Daily\n\nvm-1 disk is filling up.');
  assert.equal(report.findings[0].detail, 'root cause');
  assert.equal(store.getReport({ date: '2026-10-12' }).reportId, id);

  const list = store.list({ from: '2026-10-01', type: 'reports' });
  assert.deepEqual(list.reports.map((r) => r.title), ['Daily check']);
  assert.equal(list.reports[0].findings, 1);
  assert.equal(store.searchFindings({ source: 'report' }).findings[0].title, 'log rotation missing on vm-1');
  assert.throws(() => store.saveReport({ date: 'x', kind: 'daily', title: 't', summary: 's', bodyMarkdown: 'b', snapshotId: 999 }), /No snapshot/);
});

test('query_history_sql reads only, one statement, capped rows', async () => {
  const { store, capture } = setup();
  await capture.capture();
  const out = await store.sql({ sql: "SELECT severity, COUNT(*) AS n FROM findings WHERE title NOT LIKE '%drop%' GROUP BY severity ORDER BY severity" });
  assert.ok(out.rows.length >= 1);
  assert.equal((await store.sql({ sql: 'SELECT value FROM metrics', limit: 2 })).truncated, true);
  const before = (await store.sql({ sql: 'SELECT COUNT(*) AS n FROM findings' })).rows[0].n;
  for (const sql of [
    'DELETE FROM findings',
    'INSERT INTO reports VALUES (1)',
    'DROP TABLE findings',
    "ATTACH DATABASE '/tmp/x.db' AS x",
    'PRAGMA user_version = 0',
    'SELECT 1; DELETE FROM findings',
    'WITH x AS (SELECT 1) DELETE FROM findings',
    // Hides the write from a keyword check; SQLite's authorizer still refuses it.
    "WITH x AS (SELECT 1 AS [a'b]) DELETE FROM findings RETURNING id -- '",
  ]) {
    await assert.rejects(store.sql({ sql }), ConfigError, sql);
  }
  assert.equal((await store.sql({ sql: 'SELECT COUNT(*) AS n FROM findings' })).rows[0].n, before);
  // Reading functions that look like writes are fine.
  assert.equal((await store.sql({ sql: "SELECT replace('drop table', 'drop', 'keep') AS r" })).rows[0].r, 'keep table');
});

test('the SQL tool runs on a read-only connection for a file database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcpmon-'));
  try {
    const path = join(dir, 'history.db');
    const store = createHistoryStore(openHistoryDb(path), { path, sqlTimeoutMs: 1500 });
    store.saveReport({ date: '2026-10-14', kind: 'daily', title: 't', summary: 's', bodyMarkdown: 'b', tags: [] });
    assert.equal((await store.sql({ sql: 'SELECT COUNT(*) AS n FROM reports' })).rows[0].n, 1);
    await assert.rejects(store.sql({ sql: 'WITH x AS (SELECT 1) DELETE FROM reports RETURNING id' }), /may only read/);
    // A runaway query is killed; the server stays responsive.
    const started = Date.now();
    await assert.rejects(
      store.sql({ sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x < 0' }),
      /longer than 1.5s/,
    );
    assert.ok(Date.now() - started < 5000);
    assert.equal((await store.sql({ sql: 'SELECT COUNT(*) AS n FROM reports' })).rows[0].n, 1);
    // Even a write that slipped past the statement check fails on the read-only connection.
    const ro = openHistoryDb(path, { readOnly: true });
    assert.throws(() => ro.exec('DELETE FROM reports'), /readonly/i);
    ro.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention prune removes old snapshots, their findings and metrics', async () => {
  const { store, capture, setDay } = setup({ day: '2025-01-01' });
  await capture.capture();
  setDay('2026-10-14');
  await capture.capture();
  const removed = store.prune(30);
  assert.equal(removed.snapshots, 1);
  assert.equal(store.list({ type: 'snapshots' }).snapshots.length, 1);
  assert.equal(store.searchFindings({ to: '2025-12-31' }).findings.length, 0);
});

test('MCP: history tools are listed with local-write / read-only annotations and work end to end', async () => {
  const { store, capture } = setup();
  const server = createServer({
    projects: { list: async () => [] },
    billing: fakeBilling(),
    history: { store, capture },
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(s), client.connect(c)]);

  const { tools } = await client.listTools();
  const writes = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(writes, ['add_event', 'capture_snapshot', 'delete_event', 'save_report']);
  assert.deepEqual(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name), ['delete_event']);
  assert.equal(tools.length, 25);
  assert.match(client.getInstructions(), /history database/);

  const snap = parse(await client.callTool({ name: 'capture_snapshot', arguments: { sections: ['cost', 'vm'] } }));
  assert.ok(snap.snapshotId);
  assert.equal(snap.day, '2026-10-12');
  const saved = parse(
    await client.callTool({
      name: 'save_report',
      arguments: { title: 'Daily', summary: 'ok', bodyMarkdown: '# ok', snapshotId: snap.snapshotId },
    }),
  );
  assert.equal(saved.date, '2026-10-12');
  const got = parse(await client.callTool({ name: 'get_history', arguments: { reportId: saved.reportId } }));
  assert.equal(got.bodyMarkdown, '# ok');
  const raw = parse(await client.callTool({ name: 'get_history', arguments: { snapshotId: 'latest', section: 'vm' } }));
  assert.equal(raw.result.vms[0].name, 'vm-1');
  const anomalies = parse(await client.callTool({ name: 'find_anomalies', arguments: {} }));
  assert.equal(anomalies.date, '2026-10-12');
  const bad = await client.callTool({ name: 'query_history_sql', arguments: { sql: 'DELETE FROM reports' } });
  assert.ok(bad.isError);
  const none = await client.callTool({ name: 'get_history', arguments: {} });
  assert.ok(none.isError);
  const badDay = await client.callTool({ name: 'capture_snapshot', arguments: { day: '2026-10-14' } });
  assert.ok(badDay.isError);
});

test('config: history on by default, can be turned off, path must be absolute', () => {
  assert.equal(loadConfig({}).historyEnabled, true);
  assert.match(loadConfig({}).historyPath, /\.gcp-monitor-mcp\/history\.db$/);
  assert.equal(loadConfig({ GCP_MONITOR_HISTORY: 'off' }).historyEnabled, false);
  assert.throws(() => loadConfig({ GCP_MONITOR_DB_PATH: 'relative.db' }), /absolute/);
  assert.throws(() => loadConfig({ GCP_MONITOR_HISTORY_DAYS: '2' }), /at least 7/);
});

// ---- regression tests for the review of the day-aligned capture ----

const snapshotOf = (store, date, sections, metrics = []) =>
  store.saveSnapshot({ date, projects: [], sections: Object.keys(sections), errors: [], summary: { sections }, results: [], metrics, findings: [] });

test('a failed retry never wipes out a good earlier run of the same day', async () => {
  const { store, capture, setServices } = setup();
  const first = await capture.capture();
  const vmBefore = store.getSnapshot({ snapshotId: first.snapshotId }).findings.filter((f) => f.section === 'vm');
  assert.ok(vmBefore.length);

  setServices(fakeBilling(), fakeHealth({ vmFails: true }));
  const retry = await capture.capture();
  assert.equal(retry.sections.vm, 'ok'); // the earlier good run is kept
  const snap = store.getSnapshot({ snapshotId: retry.snapshotId });
  assert.equal(snap.findings.filter((f) => f.section === 'vm').length, vmBefore.length);
  assert.equal(store.getSnapshot({ snapshotId: retry.snapshotId, section: 'vm' }).result.vms[0].name, 'vm-1');
  const err = snap.errors.find((e) => e.section === 'vm');
  assert.equal(err.retryFailed, true);
});

test('findings of a section that failed the next day are "not checked", not resolved', async () => {
  const { store, capture, setDay, setServices } = setup();
  await capture.capture();
  setDay('2026-10-15');
  setServices(fakeBilling(), fakeHealth({ vmFails: true }));
  const out = await capture.capture();
  assert.equal(out.sections.vm, 'error');
  assert.ok(!out.sinceLastSnapshot.resolved.some((f) => f.category === 'vm'));
  assert.ok(out.sinceLastSnapshot.notChecked.some((f) => f.title === 'disk 91% full'));
  const disk = store.searchFindings({ text: 'full' }).findings[0];
  assert.equal(disk.openNow, null);
  assert.ok(store.diff({}).findings.notChecked.length >= 1);
});

test('missingDays counts days with nothing usable or a failed cost section as missing', () => {
  const store = createHistoryStore(openHistoryDb(':memory:'));
  snapshotOf(store, '2026-10-01', { cost: 'ok', vm: 'ok' });
  snapshotOf(store, '2026-10-02', { cost: 'error', vm: 'error' });
  snapshotOf(store, '2026-10-03', { cost: 'error', vm: 'ok' });
  snapshotOf(store, '2026-10-04', { cost: 'partial', vm: 'ok' });
  snapshotOf(store, '2026-10-05', { cost: 'skipped', vm: 'ok' });
  assert.deepEqual(store.missingDays('2026-10-01', '2026-10-06'), ['2026-10-02', '2026-10-03', '2026-10-06']);
});

test('capture refuses a project scope and unknown sections', async () => {
  const { capture } = setup();
  await assert.rejects(capture.capture({ projectIds: ['p'] }), /every configured project/);
  await assert.rejects(capture.capture({ sections: ['costs'] }), /No known section/);
});

test('anomalies: partial sections, sparse counts, filter-independent floor, uncaptured days', () => {
  const store = createHistoryStore(openHistoryDb(':memory:'));
  const days = Array.from({ length: 15 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  days.forEach((date, i) => {
    const last = i === days.length - 1;
    const metrics = [
      { date, kind: 'cost_total', resource: 'total', metric: 'dailyCost', value: 10_000 },
      { date, kind: 'cost_service', resource: 'Cloud DNS', metric: 'dailyCost', value: last ? 6 : 2 },
      { date, kind: 'incidents', resource: 'total', metric: 'alerts', value: last ? 0 : 1 },
    ];
    if (!last) metrics.push({ date, kind: 'incidents', resource: 'High 5xx', metric: 'alerts', value: 1 });
    if (!last) metrics.push({ date, kind: 'incidents', resource: 'Flapping LB', metric: 'alerts', value: 10 });
    if (!last) metrics.push({ date, kind: 'vm', projectId: 'p', resource: 'vm-1', metric: 'cpuPercent.avg', value: 50 });
    if (!last && i % 2) metrics.push({ date, kind: 'logs', projectId: 'p', resource: 'gce_instance/ERROR', metric: 'entries.total', value: 40 });
    if (last) metrics.push({ date, kind: 'logs', projectId: 'p', resource: 'cloudsql_database/ERROR', metric: 'entries.total', value: 25_000 });
    snapshotOf(store, date, { cost: 'ok', incidents: 'ok', logVolume: 'ok', vm: last ? 'partial' : 'ok' }, metrics);
  });
  const out = store.anomalies({});
  const by = (resource) => out.anomalies.filter((a) => a.resource === resource);
  assert.equal(by('vm-1').length, 0); // vm section only partial that day: absence proves nothing
  assert.equal(by('High 5xx').length, 0); // stopped firing: not "stopped reporting", and 1 -> 0 is under the floor
  assert.equal(by('Flapping LB')[0].type, 'drop'); // 10 a day -> 0: a recovery shows as a drop
  assert.equal(by('cloudsql_database/ERROR')[0].type, 'new'); // a brand-new error source
  assert.equal(by('Cloud DNS').length, 0); // 2 -> 6 a day on a 10,000 a day account is noise
  const filtered = store.anomalies({ kinds: ['cost_service'] });
  assert.equal(filtered.anomalies.length, 0); // same floor with a kinds filter
  assert.equal(out.sections.vm, 'partial');
  assert.throws(() => store.anomalies({ date: '2026-10-20' }), /was not captured/);
});

test('cost lines that share a key are added up; Cloud Run keeps regions apart; deleted resources keep metrics', () => {
  const day = { date: '2026-10-12' };
  const res = extractMetrics('costResources', {
    rows: [
      { resource: '//vm/big', service: 'Compute Engine', projectId: 'p', netCost: 900, currency: 'USD' },
      { resource: '//vm/big', service: 'Networking', projectId: 'p', netCost: 12, currency: 'USD' },
    ],
  }, day);
  assert.equal(res.length, 1);
  assert.equal(res[0].value, 912);
  const run = extractMetrics('cloudrun', {
    resources: [
      { name: 'api', location: 'us-central1', projectId: 'p', metrics: { requestsPerSec: { avg: 500 } } },
      { name: 'api', location: 'europe-west1', projectId: 'p', metrics: { requestsPerSec: { avg: 5 } } },
    ],
  }, day);
  assert.deepEqual(run.map((m) => m.resource).sort(), ['api@europe-west1', 'api@us-central1']);
  const vm = extractMetrics('vm', { summary: {}, vms: [], notFoundNow: [{ name: 'gone', projectId: 'p', metrics: { cpuPercent: { avg: 7 } } }] }, day);
  assert.ok(vm.some((m) => m.resource === 'gone' && m.metric === 'cpuPercent.avg'));
});

test('get_history section reads are bounded: one log preset, lists cut to limit', async () => {
  const { store } = setup();
  const entries = Array.from({ length: 120 }, (_, i) => ({ timestamp: `t${i}`, message: 'x'.repeat(2000) }));
  store.saveSnapshot({
    date: '2026-10-12',
    projects: [],
    sections: ['logs'],
    errors: [],
    summary: { sections: { logs: 'ok' } },
    results: [{ section: 'logs', args: {}, result: { byPreset: { errors: { returned: 120, entries }, changes: { returned: 0, entries: [] } } } }],
    metrics: [],
    findings: [],
  });
  const out = store.getSnapshot({ snapshotId: '2026-10-12', section: 'logs', preset: 'errors', limit: 10 });
  assert.deepEqual(Object.keys(out.result.byPreset), ['errors']);
  assert.equal(out.result.byPreset.errors.entries.length, 10);
  assert.match(out.result.byPreset.errors.entries[0].message, /… \(2000 chars\)$/);
  assert.deepEqual(out.cut[0], { path: 'byPreset.errors.entries', total: 120, returned: 10 });
  assert.equal(out.status, 'ok');
  const big = store.getSnapshot({ snapshotId: '2026-10-12', section: 'logs', limit: 500 });
  assert.equal(big.result, null);
  assert.ok(big.tooLarge.chars > 100_000);
});

test('Google-managed node VMs (GKE gke-/gk3-, VPC connector aet-) never enter VM history', async () => {
  const { isManagedNodeName } = await import('../src/gcp/vmhealth.js');
  assert.equal(isManagedNodeName('gk3-fs-storefront-web-pool-1-0689d9e3-4tfk'), true);
  assert.equal(isManagedNodeName('gke-prod-default-pool-1a2b3c4d-x1y2'), true);
  assert.equal(isManagedNodeName('gke-prod-default-pool-1a2b3c4d-x1y2', true), false);
  assert.equal(isManagedNodeName('aet-asiasouth1-fs--dev--vpc--connector-hgzw'), true);
  assert.equal(isManagedNodeName('fs-scm'), false);
  const out = extractMetrics('vm', {
    summary: {},
    vms: [],
    notFoundNow: [
      { name: 'gk3-pool-1-0689d9e3-4tfk', projectId: 'p', metrics: { cpuPercent: { avg: 50 } } },
      { name: 'aet-asiasouth1-connector-hgzw', projectId: 'p', metrics: { cpuPercent: { avg: 5 } } },
      { name: 'old-batch-vm', projectId: 'p', metrics: { cpuPercent: { avg: 7 } } },
    ],
  }, { date: '2026-10-12' });
  assert.deepEqual([...new Set(out.filter((m) => m.resource !== 'total').map((m) => m.resource))], ['old-batch-vm']);
});

test('anomalies are judged on averages and totals (and the latest disk fill), not max/latest copies', () => {
  const store = createHistoryStore(openHistoryDb(':memory:'));
  const days = Array.from({ length: 15 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  days.forEach((date, i) => {
    const v = i === days.length - 1 ? 95 : 40 + (i % 2);
    const metrics = ['avg', 'max', 'latest'].map((st) => ({ date, kind: 'vm', projectId: 'p', resource: 'vm-1', metric: `cpuPercent.${st}`, value: v }));
    metrics.push({ date, kind: 'vm', projectId: 'p', resource: 'vm-1', metric: 'diskPercent.latest', value: i === days.length - 1 ? 97 : 60 + (i % 2) });
    snapshotOf(store, date, { vm: 'ok' }, metrics);
  });
  const metrics = store.anomalies({}).anomalies.map((a) => a.metric).sort();
  assert.deepEqual(metrics, ['cpuPercent.avg', 'diskPercent.latest']);
});

test('recomputeAnomalies redoes a stored day from history without calling Google Cloud', async () => {
  const { store, capture } = setup();
  const out = await capture.capture({ sections: ['vm'] });
  store.saveSnapshot({ date: '2026-10-12', projects: [], sections: ['vm'], errors: [], summary: { sections: { vm: 'ok' } }, results: [], metrics: [], findings: [] });
  // Stale anomaly finding from older rules.
  store.replaceAnomalyFindings(store.getSnapshot({ snapshotId: '2026-10-12' }).snapshotId, [
    { category: 'vm', severity: 'low', projectId: 'p', kind: 'vm', resource: 'vm-1', title: 'anomaly: cpuPercent.max spike' },
  ]);
  const re = capture.recomputeAnomalies('2026-10-12');
  assert.equal(re.day, '2026-10-12');
  const titles = store.getSnapshot({ snapshotId: '2026-10-12' }).findings.map((f) => f.title);
  assert.ok(!titles.includes('anomaly: cpuPercent.max spike'));
  assert.ok(out.snapshotId);
  // Clean-up of managed-node metrics stored by older captures.
  store.saveSnapshot({
    date: '2026-10-11', projects: [], sections: ['vm'], errors: [], summary: { sections: { vm: 'ok' } }, results: [], findings: [],
    metrics: [
      { date: '2026-10-11', kind: 'vm', projectId: 'p', resource: 'gk3-pool-1-abc-xyz1', metric: 'cpuPercent.avg', value: 3 },
      { date: '2026-10-11', kind: 'vm', projectId: 'p', resource: 'fs-scm', metric: 'cpuPercent.avg', value: 3 },
    ],
  });
  assert.equal(store.dropManagedNodeMetrics(), 1);
  assert.deepEqual(store.metricSeries({ metric: 'cpuPercent.avg', kind: 'vm', from: '2026-10-11', to: '2026-10-11' }).series.map((s) => s.resource), ['fs-scm']);
});

// ---- planned events (sales) ----

// The September sale as captured live: Cloud SQL and GKE scaled up for 24-30 Sep; GKE came back on 1 Oct, Cloud
// SQL stayed at sale size until 8 Oct.
function saleHistory() {
  const store = createHistoryStore(openHistoryDb(':memory:'), { now: () => new Date('2026-10-15T12:00:00Z') });
  const day = (d) => new Date(Date.parse('2026-09-01T00:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);
  const sale = (d) => d >= '2026-09-24' && d <= '2026-09-30';
  const sqlUp = (d) => d >= '2026-09-24' && d <= '2026-10-08';
  for (let i = 0; i < 43; i++) {
    const date = day(i);
    const sql = sqlUp(date) ? 8150 + (i % 3) : 3280 + (i % 2);
    const gke = sale(date) ? 9800 + (i % 4) * 100 : 2900 + (i % 3) * 20;
    const other = 12000 + (i % 5) * 50;
    snapshotOf(store, date, { cost: 'ok' }, [
      { date, kind: 'cost_total', resource: 'total', metric: 'dailyCost', value: sql + gke + other, unit: 'INR' },
      { date, kind: 'cost_service', resource: 'Cloud SQL', metric: 'dailyCost', value: sql, unit: 'INR' },
      { date, kind: 'cost_service', resource: 'Google Kubernetes Engine', metric: 'dailyCost', value: gke, unit: 'INR' },
      { date, kind: 'cost_service', resource: 'BigQuery', metric: 'dailyCost', value: other, unit: 'INR' },
    ]);
  }
  return store;
}

test('events calendar: add, update, list by window, delete, validation', () => {
  const store = createHistoryStore(openHistoryDb(':memory:'));
  const e = store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  assert.deepEqual(e.window, { start: '2026-09-24', end: '2026-10-01' }); // same-day scale-up, 1 day to scale down
  assert.equal(e.kind, 'sale');
  const moved = store.saveEvent({ id: e.id, name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30', prepDays: 1 });
  assert.equal(moved.window.start, '2026-09-23');
  assert.equal(store.listEvents({ from: '2026-10-01', to: '2026-10-05' }).length, 1); // cooldown day overlaps
  assert.equal(store.listEvents({ from: '2026-10-02' }).length, 0);
  assert.throws(() => store.saveEvent({ name: 'x', startDate: '2026-10-05', endDate: '2026-10-01' }), /before startDate/);
  assert.throws(() => store.saveEvent({ id: 99, name: 'x', startDate: '2026-10-01', endDate: '2026-10-01' }), /No event/);
  assert.equal(store.deleteEvent(e.id).name, 'September sale');
  assert.equal(store.listEvents().length, 0);
});

test('anomalies: sale days are expected, kept out of baselines, and a late scale-down is flagged', () => {
  const store = saleHistory();
  // Without the calendar, the sale is a pile of spikes.
  assert.ok(store.anomalies({ date: '2026-09-25' }).anomalies.some((a) => a.resource === 'Google Kubernetes Engine'));
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });

  const during = store.anomalies({ date: '2026-09-25' });
  assert.equal(during.onEvent.phase, 'during');
  assert.ok(during.anomalies.length && during.anomalies.every((a) => a.expected?.event === 'September sale'));

  // 3 Oct: GKE is back (no anomaly), Cloud SQL is still at sale size two days after the cooldown.
  const after = store.anomalies({ date: '2026-10-03' });
  assert.equal(after.onEvent, undefined);
  assert.equal(after.afterEvent.daysAfterEnd, 3);
  assert.equal(after.baseline.eventDaysSkipped, 9); // 24 Sep - 2 Oct: the sale, its cooldown, and the days after it
  const sql = after.anomalies.find((a) => a.resource === 'Cloud SQL');
  assert.equal(sql.notScaledDown.event, 'September sale');
  assert.ok(sql.notScaledDown.extraPerDay > 4800);
  assert.equal(after.anomalies.find((a) => a.resource === 'Google Kubernetes Engine'), undefined);
  // A spike in something the sale didn't scale up, or far above sale level, is not put down to the sale.
  assert.ok(after.anomalies.filter((a) => a.notScaledDown).every((a) => a.resource === 'Cloud SQL' || a.kind === 'cost_total'));

  // The finding has a stable title, so its recurrence counts the late days.
  assert.equal(anomalyFinding(sql).title, 'not scaled down after sale');
  assert.equal(anomalyFinding(sql).severity, 'high');
  // Once Cloud SQL is back (9 Oct), nothing is flagged; normal days compare with normal days only.
  assert.equal(store.anomalies({ date: '2026-10-10' }).anomalies.filter((a) => a.resource === 'Cloud SQL').length, 0);
});

test('review_event: cost of the sale, what scaled up, late scale-downs and the previous sale', () => {
  const store = saleHistory();
  store.saveEvent({ name: 'August sale', startDate: '2026-09-02', endDate: '2026-09-03' }); // stands in for an earlier sale
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  const r = store.reviewEvent({ date: '2026-10-13' });
  assert.equal(r.event.name, 'September sale');
  assert.equal(r.totals.eventDays, 7);
  assert.ok(r.totals.extraCost > 7 * (4800 + 6800));
  assert.deepEqual(r.scaledUpMost.slice(0, 2).map((x) => x.resource), ['Google Kubernetes Engine', 'Cloud SQL']);
  const gke = r.scaledUpMost.find((x) => x.resource === 'Google Kubernetes Engine');
  assert.equal(gke.scaledDownOn, '2026-10-01');
  assert.equal(gke.daysToScaleDown, 1);
  const late = r.notScaledDown.find((x) => x.resource === 'Cloud SQL');
  assert.equal(late.scaledDownOn, '2026-10-09');
  assert.equal(late.lateDays, 7); // 2-8 Oct, after the 1-day cooldown
  assert.ok(late.extraAfterCooldown > 7 * 4800);
  assert.equal(r.previous.event.name, 'August sale');
  assert.ok(r.vsPrevious.extraCostChangePct != null);
  assert.throws(() => createHistoryStore(openHistoryDb(':memory:')).reviewEvent({}), /No events recorded/);
});

test('capture: expected sale anomalies make no findings; late scale-downs do', async () => {
  const store = saleHistory();
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  const capture = createCaptureService({ billing: fakeBilling(), store, now: () => new Date('2026-10-15T12:00:00Z') });
  const during = capture.recomputeAnomalies('2026-09-25');
  assert.ok(during.anomalies > 0);
  assert.equal(store.getSnapshot({ snapshotId: '2026-09-25' }).findings.filter((f) => f.section === 'anomalies').length, 0);
  capture.recomputeAnomalies('2026-10-03');
  const titles = store.getSnapshot({ snapshotId: '2026-10-03' }).findings.map((f) => f.title);
  assert.ok(titles.includes('not scaled down after sale'));
});

// ---- review of the sales logic: regression tests ----

// A day-indexed history with Cloud SQL / GKE / BigQuery lines; `sql(date)` etc. give each day's value.
function costHistory({ days = 70, sql, gke = () => 2900, bq = () => 12000, extra = () => [] }) {
  const store = createHistoryStore(openHistoryDb(':memory:'), { now: () => new Date('2026-11-15T12:00:00Z') });
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
    const v = { sql: sql(date, i), gke: gke(date, i), bq: bq(date, i) };
    snapshotOf(store, date, { cost: 'ok', logVolume: 'ok', cloudsql: 'ok' }, [
      { date, kind: 'cost_total', resource: 'total', metric: 'dailyCost', value: v.sql + v.gke + v.bq, unit: 'INR' },
      { date, kind: 'cost_service', resource: 'Cloud SQL', metric: 'dailyCost', value: v.sql, unit: 'INR' },
      { date, kind: 'cost_service', resource: 'Google Kubernetes Engine', metric: 'dailyCost', value: v.gke, unit: 'INR' },
      { date, kind: 'cost_service', resource: 'BigQuery', metric: 'dailyCost', value: v.bq, unit: 'INR' },
      ...extra(date, i),
    ]);
  }
  return store;
}
const inSep = (d) => d >= '2026-09-24' && d <= '2026-09-30';

test('on a sale day only extra load and spend is expected: errors and a vanished resource are still findings', () => {
  const store = costHistory({
    sql: (d, i) => (inSep(d) ? 8150 : 3280 + (i % 2)),
    extra: (d, i) => [
      { date: d, kind: 'logs', projectId: 'p', resource: 'k8s_container/ERROR', metric: 'entries.total', value: d === '2026-09-26' ? 5000 : 10 + (i % 3) },
      ...(d === '2026-09-26' ? [] : [{ date: d, kind: 'cloudsql', projectId: 'p', resource: 'fsdev', metric: 'cpuPercent.avg', value: 40 + (i % 2) }]),
    ],
  });
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  const out = store.anomalies({ date: '2026-09-26' });
  const by = (r) => out.anomalies.find((a) => a.resource === r);
  assert.ok(by('Cloud SQL').expected); // the scale-up: expected
  assert.equal(by('k8s_container/ERROR').expected, undefined); // an error storm: still a problem
  assert.equal(by('fsdev').type, 'missing');
  assert.equal(by('fsdev').expected, undefined);
  const capture = createCaptureService({ billing: fakeBilling(), store, now: () => new Date('2026-11-15T12:00:00Z') });
  capture.recomputeAnomalies('2026-09-26');
  const titles = store.getSnapshot({ snapshotId: '2026-09-26' }).findings.map((f) => `${f.resource}: ${f.title}`);
  assert.ok(titles.includes('k8s_container/ERROR: anomaly: entries.total spike'));
  assert.ok(titles.includes('fsdev: anomaly: stopped reporting'));
  assert.ok(!titles.some((t) => t.startsWith('Cloud SQL')));
});

test('a scale-up left in place for weeks stays "not scaled down" and never becomes the baseline', () => {
  // Cloud SQL up from 24 Sep and never scaled back down.
  const store = costHistory({ sql: (d, i) => (d >= '2026-09-24' ? 8150 + (i % 3) : 3280 + (i % 2)) });
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  for (const day of ['2026-10-03', '2026-10-20', '2026-11-05']) {
    const sql = store.anomalies({ date: day }).anomalies.find((a) => a.resource === 'Cloud SQL');
    assert.ok(sql?.notScaledDown, day);
    assert.ok(sql.notScaledDown.extraPerDay > 4800, day);
  }
  const r = store.reviewEvent({ id: 1 });
  const late = r.notScaledDown.find((x) => x.resource === 'Cloud SQL');
  assert.match(late.scaledDownOn, /^not by /);
  assert.ok(late.lateDays > 30); // counted for as long as it stays up, not 14 days
});

test('review_event: baseline skips the previous sale and its aftermath; steady growth is not a scale-up', () => {
  const store = costHistory({
    // September: Cloud SQL stays up until 9 Oct. October sale 20-22 Oct scaled down on time.
    sql: (d, i) => (d >= '2026-09-24' && d <= '2026-10-08') || (d >= '2026-10-20' && d <= '2026-10-22') ? 8150 : 3280 + (i % 2),
    gke: (d) => (inSep(d) || (d >= '2026-10-20' && d <= '2026-10-22') ? 9800 : 2900),
    bq: (d, i) => 12000 + 20 * i, // grows 20 a day, unrelated to sales
  });
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  store.saveEvent({ name: 'October sale', startDate: '2026-10-20', endDate: '2026-10-22' });
  const oct = store.reviewEvent({ id: 2 });
  const sql = oct.scaledUpMost.find((x) => x.resource === 'Cloud SQL');
  assert.ok(Math.abs(sql.normalPerDay - 3280.5) < 1); // not polluted by Sep's 2-8 Oct lingering
  assert.equal(sql.scaledDownOn, '2026-10-23');
  assert.ok(!oct.scaledUpMost.some((x) => x.resource === 'BigQuery'));
  assert.ok(!oct.notScaledDown.some((x) => x.resource === 'BigQuery'));
  const sep = store.reviewEvent({ id: 1 });
  assert.equal(sep.notScaledDown.find((x) => x.resource === 'Cloud SQL').lateDays, 7);
  assert.ok(!sep.notScaledDown.some((x) => x.resource === 'BigQuery'));
});

test('review_event defaults to the latest sale that has happened, not an upcoming one', () => {
  const store = costHistory({ days: 45, sql: (d) => (inSep(d) ? 8150 : 3280) });
  store.saveEvent({ name: 'Upcoming sale', startDate: '2026-12-01', endDate: '2026-12-03' });
  assert.throws(() => store.reviewEvent({}), /No event started on or before 2026-10-15; the next one is "Upcoming sale"/);
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  assert.equal(store.reviewEvent({}).event.name, 'September sale');
});

test('updating an event keeps the fields that were left out', () => {
  const store = createHistoryStore(openHistoryDb(':memory:'));
  const e = store.saveEvent({ kind: 'sale', name: 'Diwali sale', startDate: '2026-11-01', endDate: '2026-11-05', prepDays: 2, cooldownDays: 3, notes: 'big one' });
  const moved = store.saveEvent({ id: e.id, endDate: '2026-11-06' });
  assert.deepEqual([moved.name, moved.startDate, moved.endDate, moved.prepDays, moved.cooldownDays, moved.notes], ['Diwali sale', '2026-11-01', '2026-11-06', 2, 3, 'big one']);
  assert.throws(() => store.saveEvent({ id: e.id, startDate: '2026-11-10' }), /before startDate/);
  assert.throws(() => store.saveEvent({ name: 'x' }), /needs name, startDate and endDate/);
});

test('MCP: adding or deleting a sale re-judges the days already captured', async () => {
  const store = costHistory({ days: 40, sql: (d, i) => (inSep(d) ? 8150 : 3280 + (i % 2)) });
  const capture = createCaptureService({ billing: fakeBilling(), store, now: () => new Date('2026-11-15T12:00:00Z') });
  for (const d of ['2026-09-25', '2026-09-26']) capture.recomputeAnomalies(d);
  const before = store.getSnapshot({ snapshotId: '2026-09-25' }).findings.filter((f) => f.section === 'anomalies').length;
  assert.ok(before > 0);
  const server = createServer({ projects: { list: async () => [] }, billing: fakeBilling(), history: { store, capture } });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(s), client.connect(c)]);
  const added = parse(await client.callTool({ name: 'add_event', arguments: { name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' } }));
  assert.equal(added.event.cooldownDays, 1);
  assert.ok(added.rejudgedDays >= 17); // 24 Sep onwards
  assert.equal(store.getSnapshot({ snapshotId: '2026-09-25' }).findings.filter((f) => f.section === 'anomalies').length, 0);
  const del = parse(await client.callTool({ name: 'delete_event', arguments: { id: added.event.id } }));
  assert.ok(del.rejudgedDays >= 17);
  assert.equal(store.getSnapshot({ snapshotId: '2026-09-25' }).findings.filter((f) => f.section === 'anomalies').length, before);
});

test('an alert that starts during a sale and stays on afterwards is "not scaled down" (sparse counts are 0 before)', () => {
  const store = costHistory({
    days: 40,
    sql: (d, i) => 3280 + (i % 2),
    extra: (d) => (d >= '2026-09-28' && d <= '2026-10-08' ? [{ date: d, kind: 'incidents', resource: 'fsdev memory', metric: 'minutes', value: 1440 }] : []),
  });
  // The incidents section ran every day, so absent days count as 0 minutes.
  for (const day of store.list({ type: 'snapshots', limit: 100 }).snapshots) {
    store.saveSnapshot({ date: day.date, projects: [], sections: ['incidents'], errors: [], summary: { sections: { incidents: 'ok' } }, results: [], metrics: [], findings: [] });
  }
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  const a = store.anomalies({ date: '2026-10-04' }).anomalies.find((x) => x.resource === 'fsdev memory');
  assert.equal(a.notScaledDown?.event, 'September sale');
});

test('"not scaled down" needs the series to have stayed up since the sale: a later, separate rise is a plain anomaly', () => {
  const store = costHistory({
    days: 45,
    // Cloud SQL scaled up for the sale, back to normal on 2 Oct, then up again on 9 Oct (a resize, not the sale).
    sql: (d, i) => (inSep(d) || d === '2026-10-01' || d >= '2026-10-09' ? 8150 : 3280 + (i % 2)),
  });
  store.saveEvent({ name: 'September sale', startDate: '2026-09-24', endDate: '2026-09-30' });
  const sql = store.anomalies({ date: '2026-10-10' }).anomalies.find((a) => a.resource === 'Cloud SQL');
  assert.equal(sql.type, 'spike');
  assert.equal(sql.notScaledDown, undefined);
});

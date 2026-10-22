import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createAppOptimizeService, pacificDate } from '../src/gcp/appoptimize.js';
import { compareCosts, comparisonWindows, addDays } from '../src/gcp/comparison.js';
import { loadConfig } from '../src/config.js';

const windows = comparisonWindows('2026-10-12', 7, 21);

// Same cost every day of both windows, plus overrides per [service, day].
function days(service, perDay, overrides = {}) {
  const out = [];
  for (let d = windows.baseline.startDate; d <= windows.current.endDate; d = addDays(d, 1)) {
    out.push({ service, day: d, cost: overrides[d] ?? perDay });
  }
  return out;
}

test('windows: 7 days ending on endDate, baseline right before it', () => {
  assert.deepEqual(windows, {
    current: { startDate: '2026-10-06', endDate: '2026-10-12', days: 7 },
    baseline: { startDate: '2026-09-15', endDate: '2026-10-05', days: 21 },
  });
});

test('flags spikes, increases, new and stopped spend, normalized per day', () => {
  const steady = days('Cloud SQL', 1000, { '2026-09-20': 1010, '2026-09-21': 990 });
  const spiky = days('BigQuery', 100, { '2026-10-09': 900 });
  const growing = days('Compute Engine', 200).map((r) => (r.day >= '2026-10-06' ? { ...r, cost: 300 } : r));
  const fresh = days('Vertex AI', 0).map((r) => (r.day >= '2026-10-06' ? { ...r, cost: 50 } : r));
  const tiny = days('Cloud DNS', 0.1).map((r) => (r.day >= '2026-10-06' ? { ...r, cost: 0.5 } : r)); // +400% but noise

  const out = compareCosts({
    windows,
    serviceDays: [...steady, ...spiky, ...growing, ...fresh, ...tiny],
    currentResources: [
      { resource: 'vm-1', service: 'Compute Engine', projectId: 'a', cost: 7 * 300 },
      { resource: 'vm-new', service: 'Compute Engine', projectId: 'a', cost: 7 * 40 },
    ],
    baselineResources: [
      { resource: 'vm-1', service: 'Compute Engine', projectId: 'a', cost: 21 * 200 },
      { resource: 'db-old', service: 'Cloud SQL', projectId: 'b', cost: 21 * 60 },
    ],
    threshold: 25,
    limit: 50,
    currency: 'INR',
  });

  const flagged = Object.fromEntries(out.services.map((s) => [s.service, s.flags ?? []]));
  assert.deepEqual(flagged, {
    'Cloud SQL': [],
    'Compute Engine': ['increase'],
    BigQuery: ['spike'],
    'Vertex AI': ['new'],
    'Cloud DNS': [],
  });

  const spike = out.anomalies.find((a) => a.type === 'spike');
  assert.deepEqual(spike.spikeDays, [{ day: '2026-10-09', cost: 900 }]);
  assert.equal(spike.baselineDailyMean, 100);

  const compute = out.services.find((s) => s.service === 'Compute Engine');
  assert.deepEqual(
    { ...compute, flags: undefined },
    {
      service: 'Compute Engine',
      current: 2100,
      currentPerDay: 300,
      baselinePerDay: 200,
      deltaPerDay: 100,
      changePct: 50,
      flags: undefined,
    },
  );

  const res = Object.fromEntries(out.resources.map((r) => [r.resource, r.flags ?? []]));
  assert.deepEqual(res, { 'vm-1': ['increase'], 'db-old': ['stopped'], 'vm-new': ['new'] });
  assert.equal(out.resources[0].resource, 'vm-1'); // biggest daily move first

  assert.equal(out.current.days, 7);
  assert.ok(out.anomalies.every((a, i, all) => i === 0 || Math.abs(all[i - 1].deltaPerDay) >= Math.abs(a.deltaPerDay)));
});

const COST = {
  name: 'cost',
  type: 'RECORD',
  columns: [{ name: 'currency_code' }, { name: 'units' }, { name: 'nanos' }],
};
const str = (s) => ({ stringValue: s });
const cost = (units) => ({ listValue: { values: [str('INR'), str(String(units)), { numberValue: 0 }] } });

test('get_cost_comparison runs daily and per-window resource reports and enforces the App Optimize lookback', async () => {
  const calls = [];
  const client = {
    createReport: async (req) => {
      calls.push(req.report);
      return [{ promise: async () => [{ name: `r${calls.length}` }] }];
    },
    readReport: async ({ name }) => {
      const report = calls[Number(name.slice(1)) - 1];
      if (report.dimensions.includes('day')) {
        return [
          null,
          null,
          {
            columns: [{ name: 'product_display_name' }, { name: 'day' }, COST],
            rows: [{ values: [str('Cloud SQL'), str('2026-10-10'), cost(70)] }],
          },
        ];
      }
      return [
        null,
        null,
        {
          columns: [
            { name: 'resource' },
            { name: 'product_display_name' },
            { name: 'project' },
            { name: 'resource_type' },
            COST,
          ],
          rows: [{ values: [str('db-1'), str('Cloud SQL'), str('projects/fs-life-prod'), str('sqladmin'), cost(70)] }],
        },
      ];
    },
    deleteReport: async () => [{}],
  };
  const config = loadConfig({ GCP_COST_REPORT_PROJECT: 'fs-life-prod' });
  const server = createServer({
    projects: { list: async () => [] },
    billing: createAppOptimizeService(config, client),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(s), mcp.connect(c)]);

  const end = addDays(pacificDate(), -2);
  const res = await mcp.callTool({ name: 'get_cost_comparison', arguments: { endDate: end } });
  assert.ok(!res.isError, res.content[0].text);
  const out = JSON.parse(res.content[0].text);

  assert.equal(calls.length, 3);
  assert.equal(out.current.endDate, end);
  assert.equal(out.currency, 'INR');
  assert.equal(out.resources[0].projectId, 'fs-life-prod');
  const filters = calls.map((r) => r.filter);
  assert.ok(filters.some((f) => f.includes(`timestamp('${out.baseline.startDate}`)));

  // A baseline older than App Optimize's history (about a year) is refused, not answered with empty days.
  const tooOld = await mcp.callTool({ name: 'get_cost_comparison', arguments: { endDate: '2025-09-01' } });
  assert.ok(tooOld.isError);
  assert.match(tooOld.content[0].text, /last 365 days/);
});

test('BigQuery jobs fold into one row per project', () => {
  const windows = comparisonWindows('2026-10-12', 7, 21);
  const job = (id, cost) => ({
    resource: `//bigquery.googleapis.com/projects/p/jobs/${id}`,
    service: 'BigQuery',
    projectId: 'p',
    resourceType: 'bigquery.googleapis.com/Job',
    cost,
  });
  const out = compareCosts({
    windows,
    serviceDays: [],
    currentResources: [job('a', 70), job('b', 70)],
    baselineResources: [job('c', 210)],
    threshold: 25,
    limit: 10,
    currency: 'INR',
  });
  assert.equal(out.resources.length, 1);
  assert.equal(out.resources[0].resource, '//bigquery.googleapis.com/projects/p/jobs/*');
  assert.equal(out.resources[0].current, 140);
});

test('flags are decided on exact per-day values, not the rounded ones shown', () => {
  const windows = comparisonWindows('2026-10-12', 7, 21);
  const out = compareCosts({
    windows,
    serviceDays: [{ service: 'Big', day: '2026-10-10', cost: 7000 }, { service: 'Big', day: '2026-10-01', cost: 21000 }],
    currentResources: [{ resource: 'tiny', service: 'S', projectId: 'p', cost: 7 * 0.004 }],
    baselineResources: [{ resource: 'tiny', service: 'S', projectId: 'p', cost: 21 * 60 }],
    threshold: 25,
    limit: 10,
    currency: 'INR',
  });
  const tiny = out.resources.find((r) => r.resource === 'tiny');
  assert.equal(tiny.currentPerDay, 0); // shown rounded...
  assert.deepEqual(tiny.flags, ['decrease']); // ...but not reported as "stopped"
});

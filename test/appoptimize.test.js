import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createAppOptimizeService, toObject, bucket, pacificMidnight } from '../src/gcp/appoptimize.js';
import { loadConfig } from '../src/config.js';

const COST = {
  name: 'cost',
  type: 'RECORD',
  columns: [{ name: 'currency_code' }, { name: 'units' }, { name: 'nanos' }],
};
const str = (s) => ({ stringValue: s });
const cost = (units, nanos = 0, cur = 'INR') => ({
  listValue: { values: [str(cur), str(String(units)), { numberValue: nanos }] },
});

// Fake App Optimize client: serves `pages` of rows and records every call.
function fakeClient(columns, pages) {
  const calls = { create: [], read: [], del: [] };
  return {
    calls,
    createReport: async (req) => (calls.create.push(req), [{ promise: async () => [{ name: 'reports/r1' }] }]),
    readReport: async (req) => {
      calls.read.push(req);
      const i = req.pageToken ? Number(req.pageToken) : 0;
      return [null, null, { columns, rows: pages[i], nextPageToken: i + 1 < pages.length ? String(i + 1) : '' }];
    },
    deleteReport: async (req) => (calls.del.push(req), [{}]),
  };
}

async function connect(client, env = {}) {
  const config = loadConfig({ GCP_COST_REPORT_PROJECT: 'fs-life-prod', ...env });
  const server = createServer({
    projects: { list: async () => [] },
    billing: createAppOptimizeService(config, client),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(s), mcp.connect(c)]);
  return mcp;
}

const parse = (res) => JSON.parse(res.content[0].text);

test('summary sums days per service across pages, sorts, and cleans up the report', async () => {
  const columns = [{ name: 'product_display_name', type: 'STRING' }, { name: 'day', type: 'STRING' }, COST];
  const client = fakeClient(columns, [
    [
      { values: [str('Cloud SQL'), str('2026-10-01'), cost(1000, 500_000_000)] },
      { values: [str('Compute Engine'), str('2026-10-01'), cost(300)] },
    ],
    [{ values: [str('Cloud SQL'), str('2026-10-02'), cost(1000)] }],
  ]);
  const mcp = await connect(client);
  const out = parse(
    await mcp.callTool({
      name: 'get_cost_summary',
      arguments: { startDate: '2026-10-01', endDate: '2026-10-02', groupBy: 'service' },
    }),
  );

  assert.deepEqual(out.rows, [
    { service: 'Cloud SQL', cost: 2000.5, currency: 'INR' },
    { service: 'Compute Engine', cost: 300, currency: 'INR' },
  ]);
  assert.deepEqual(out.totals, { INR: { cost: 2300.5, groups: 2 } });
  assert.equal(out.source, 'app-optimize');

  const [req] = client.calls.create;
  assert.equal(req.parent, 'projects/fs-life-prod/locations/global');
  assert.match(req.reportId, /^mcp-[a-z0-9-]+$/);
  assert.deepEqual(req.report.dimensions, ['product_display_name']); // no day: fewer rows to page
  assert.deepEqual(req.report.metrics, ['cost']);
  assert.deepEqual(req.report.scopes, [{ project: 'projects/fs-life-prod' }]);
  assert.equal(
    req.report.filter,
    "day >= timestamp('2026-10-01T00:00:00-07:00') && day < timestamp('2026-10-03T00:00:00-07:00')",
  );
  assert.equal(client.calls.read.length, 2);
  await new Promise((r) => setImmediate(r));
  assert.equal(client.calls.del.length, 1);
});

test('runs one single-scope report per project and filters by service', async () => {
  const client = fakeClient([{ name: 'day', type: 'STRING' }, COST], [[]]);
  const mcp = await connect(client, { GCP_MONITOR_ALLOWED_PROJECTS: 'a,b' });
  await mcp.callTool({ name: 'get_cost_trend', arguments: { service: 'Cloud SQL' } });
  const scopes = client.calls.create.map((c) => c.report.scopes);
  assert.deepEqual(scopes.sort(), [[{ project: 'projects/a' }], [{ project: 'projects/b' }]]);
  assert.match(client.calls.create[0].report.filter, /product_display_name == 'Cloud SQL'$/);

  const denied = await mcp.callTool({ name: 'get_cost_trend', arguments: { projectIds: ['c'] } });
  assert.ok(denied.isError);
});

test('merges projects for group-by-project and reports projects that failed', async () => {
  const columns = [{ name: 'day', type: 'STRING' }, COST]; // no project column: rows get tagged
  const client = fakeClient(columns, [[{ values: [str('2026-10-01'), cost(10)] }]]);
  const create = client.createReport;
  client.createReport = async (req) => {
    if (req.report.scopes[0].project === 'projects/c') throw new Error('7 PERMISSION_DENIED: billing.resourceCosts.get');
    return create(req);
  };
  const mcp = await connect(client, { GCP_MONITOR_ALLOWED_PROJECTS: 'a,b,c' });
  const out = parse(await mcp.callTool({ name: 'get_cost_summary', arguments: { groupBy: 'project' } }));
  assert.deepEqual(out.rows, [
    { project: 'a', cost: 10, currency: 'INR' },
    { project: 'b', cost: 10, currency: 'INR' },
  ]);
  assert.equal(out.failedProjects.length, 1);
  assert.equal(out.failedProjects[0].projectId, 'c');

  // Every project failing is a tool error, not an empty result.
  const res = await mcp.callTool({ name: 'get_cost_summary', arguments: { projectIds: ['c'] } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /Permission denied/);
});

// Copied from the API's INVALID_ARGUMENT message; day/month/hour may be added to any of them.
const ALLOWED = [
  'application,product_display_name',
  'application',
  'location,product_display_name,project,resource,resource_type,sku',
  'location,product_display_name,project,resource,resource_type',
  'location,product_display_name,project,service_or_workload',
  'location,product_display_name,project,sku',
  'product_display_name,project',
  'product_display_name,resource_type',
  'product_display_name,resource',
  'product_display_name',
  'project',
];

test('every tool asks for a dimension combination the API allows', async () => {
  const client = fakeClient([{ name: 'day', type: 'STRING' }, COST], [[]]);
  const mcp = await connect(client);
  for (const groupBy of ['service', 'project', 'sku', 'region']) {
    await mcp.callTool({ name: 'get_cost_summary', arguments: { groupBy } });
  }
  await mcp.callTool({ name: 'get_cost_trend', arguments: {} });
  await mcp.callTool({ name: 'get_top_cost_resources', arguments: {} });
  assert.equal(client.calls.create.length, 6);
  for (const { report } of client.calls.create) {
    const dims = report.dimensions.filter((d) => !['day', 'month', 'hour'].includes(d)).sort().join(',');
    assert.ok(ALLOWED.includes(dims), `not allowed: ${dims}`);
  }
});

test('falls back to selecting day if the API will not filter on it otherwise', async () => {
  const client = fakeClient([{ name: 'product_display_name', type: 'STRING' }, COST], [[]]);
  const create = client.createReport;
  client.createReport = async (req) => {
    if (!req.report.dimensions.includes('day')) {
      throw Object.assign(new Error('3 INVALID_ARGUMENT: filter references unselected dimension day'), { code: 3 });
    }
    return create(req);
  };
  const mcp = await connect(client);
  const res = await mcp.callTool({ name: 'get_cost_summary', arguments: {} });
  assert.ok(!res.isError, res.content[0].text);
  assert.deepEqual(client.calls.create.at(-1).report.dimensions, ['product_display_name', 'day']);
});

test('trend buckets days into weeks', async () => {
  const columns = [{ name: 'day', type: 'STRING' }, COST];
  const client = fakeClient(columns, [
    [
      { values: [str('2026-10-05'), cost(10)] }, // Monday
      { values: [str('2026-10-07'), cost(5)] },
      { values: [str('2026-10-12'), cost(1)] }, // next Monday
    ],
  ]);
  const mcp = await connect(client);
  const out = parse(await mcp.callTool({ name: 'get_cost_trend', arguments: { granularity: 'week' } }));
  assert.deepEqual(out.points, [
    { period: '2026-10-05', cost: 15, currency: 'INR' },
    { period: '2026-10-12', cost: 1, currency: 'INR' },
  ]);
});

test('top resources groups by resource and strips the projects/ prefix', async () => {
  const columns = [
    { name: 'resource', type: 'STRING' },
    { name: 'product_display_name', type: 'STRING' },
    { name: 'project', type: 'STRING' },
    { name: 'resource_type', type: 'STRING' },
    { name: 'day', type: 'STRING' },
    COST,
  ];
  const r = (res, day, units) => ({
    values: [str(res), str('Cloud SQL'), str('projects/fs-life-prod'), str('sqladmin.googleapis.com/Instance'), str(day), cost(units)],
  });
  const client = fakeClient(columns, [
    [r('db-1', '2026-10-01', 5), r('db-1', '2026-10-02', 5), r('db-2', '2026-10-01', 7)],
  ]);
  const mcp = await connect(client);
  const out = parse(await mcp.callTool({ name: 'get_top_cost_resources', arguments: { limit: 1 } }));
  assert.deepEqual(out.rows, [
    { resource: 'db-1', service: 'Cloud SQL', projectId: 'fs-life-prod', resourceType: 'sqladmin.googleapis.com/Instance', cost: 10, currency: 'INR' },
  ]);
});

test('without any cost source, tools explain how to configure one', async () => {
  const config = loadConfig({});
  const server = createServer({
    projects: { list: async () => [] },
    billing: createAppOptimizeService(config, fakeClient([], [[]])),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(s), mcp.connect(c)]);
  const res = await mcp.callTool({ name: 'get_cost_summary', arguments: {} });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /GCP_COST_REPORT_PROJECT/);
});

test('decodes cost records given as structs too', () => {
  const row = {
    values: [
      { structValue: { fields: { currencyCode: str('USD'), units: str('3'), nanos: { numberValue: 250_000_000 } } } },
    ],
  };
  assert.deepEqual(toObject(row, [{ name: 'cost', type: 'RECORD' }]).cost, { amount: 3.25, currency: 'USD' });
});

test('date helpers', () => {
  assert.equal(pacificMidnight('2026-01-15'), '2026-01-15T00:00:00-08:00'); // PST
  assert.equal(pacificMidnight('2026-07-15'), '2026-07-15T00:00:00-07:00'); // PDT
  assert.equal(bucket('2026-10-11', 'week'), '2026-10-05');
  assert.equal(bucket('2026-10-11', 'month'), '2026-10');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, withDates, explain } from '../src/server.js';
import { createBillingService } from '../src/gcp/billing.js';
import { loadConfig } from '../src/config.js';

const TABLE = 'billing-proj.billing.gcp_billing_export_resource_v1_0000AA_BBBBBB_CCCCCC';

// Fake BigQuery that records each query and returns canned rows.
function fakeBigQuery(rows = []) {
  const calls = [];
  return { calls, query: async (opts) => (calls.push(opts), [rows]) };
}

async function connect({ env = {}, rows = [], projects = [] } = {}) {
  const config = loadConfig({ GCP_BILLING_EXPORT_TABLE: TABLE, ...env });
  const bq = fakeBigQuery(rows);
  const server = createServer({
    projects: { list: async () => projects },
    billing: createBillingService(config, bq),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, bq };
}

const parse = (res) => JSON.parse(res.content[0].text);

test('lists every tool, all read-only', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'get_cloudsql_health',
    'get_cost_comparison',
    'get_cost_summary',
    'get_cost_trend',
    'get_gke_health',
    'get_incidents',
    'get_resource_usage',
    'get_top_cost_resources',
    'get_vm_health',
    'list_projects',
    'list_resources',
    'query_logs',
  ]);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
});

test('list_projects returns the projects', async () => {
  const { client } = await connect({ projects: [{ projectId: 'a', name: 'A' }] });
  const out = parse(await client.callTool({ name: 'list_projects', arguments: {} }));
  assert.equal(out.count, 1);
});

test('get_cost_summary binds params, caps bytes billed and shapes rows', async () => {
  const rows = [
    {
      dim: 'Compute Engine',
      currency: 'USD',
      cost: 120.456,
      credits: -20.1,
      net_cost: 100.356,
      total_net_cost: 150.5,
      total_groups: 2,
      data_as_of: { value: '2026-10-10T06:00:00Z' },
    },
    {
      dim: 'Cloud Run',
      currency: 'USD',
      cost: 50.2,
      credits: 0,
      net_cost: 50.2,
      total_net_cost: 150.5,
      total_groups: 2,
      data_as_of: { value: '2026-10-10T06:00:00Z' },
    },
  ];
  const { client, bq } = await connect({ rows });
  const res = await client.callTool({
    name: 'get_cost_summary',
    arguments: { startDate: '2026-09-01', endDate: '2026-09-30', groupBy: 'service', projectIds: ['p1'] },
  });
  const out = parse(res);

  assert.equal(out.rows[0].service, 'Compute Engine');
  assert.equal(out.rows[0].netCost, 100.36);
  assert.deepEqual(out.totals, { USD: { netCost: 150.5, groups: 2 } });
  assert.equal(out.dataAsOf, '2026-10-10T06:00:00Z');

  const [call] = bq.calls;
  assert.match(call.query, /FROM `billing-proj\.billing\.gcp_billing_export_resource_v1_/);
  assert.match(call.query, /_PARTITIONTIME/);
  assert.deepEqual(call.params, {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    projectIds: ['p1'],
    service: null,
    limit: 25,
  });
  assert.equal(call.maximumBytesBilled, String(5 * 1024 ** 3));
});

test('rejects groupBy values outside the whitelist', async () => {
  const { client, bq } = await connect();
  const res = await client.callTool({ name: 'get_cost_summary', arguments: { groupBy: 'x; DROP TABLE' } });
  assert.ok(res.isError);
  assert.equal(bq.calls.length, 0);
});

test('allowlist: defaults to allowed projects and rejects others', async () => {
  const { client, bq } = await connect({ env: { GCP_MONITOR_ALLOWED_PROJECTS: 'a, b' } });
  await client.callTool({ name: 'get_cost_trend', arguments: {} });
  assert.deepEqual(bq.calls[0].params.projectIds, ['a', 'b']);

  const res = await client.callTool({ name: 'get_cost_trend', arguments: { projectIds: ['c'] } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /not in GCP_MONITOR_ALLOWED_PROJECTS: c/);
});

test('get_cost_trend uses the requested granularity', async () => {
  const rows = [{ bucket: { value: '2026-09-01' }, currency: 'USD', net_cost: 10.123 }];
  const { client, bq } = await connect({ rows });
  const out = parse(await client.callTool({ name: 'get_cost_trend', arguments: { granularity: 'month' } }));
  assert.match(bq.calls[0].query, /DATE_TRUNC\(DATE\(usage_start_time\), MONTH\)/);
  assert.deepEqual(out.points, [{ period: '2026-09-01', netCost: 10.12, currency: 'USD' }]);
});

test('get_top_cost_resources refuses the standard export with a clear message', async () => {
  const { client, bq } = await connect({
    env: { GCP_BILLING_EXPORT_TABLE: 'billing-proj.billing.gcp_billing_export_v1_0000AA_BBBBBB_CCCCCC' },
  });
  const res = await client.callTool({ name: 'get_top_cost_resources', arguments: {} });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /Detailed usage cost/);
  assert.equal(bq.calls.length, 0);
});

test('cost tools explain missing billing config', async () => {
  const config = loadConfig({});
  const server = createServer({
    projects: { list: async () => [] },
    billing: createBillingService(config, fakeBigQuery()),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(s), client.connect(c)]);
  const res = await client.callTool({ name: 'get_cost_summary', arguments: {} });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /GCP_BILLING_EXPORT_TABLE/);
});

test('withDates defaults to month-to-date and rejects inverted ranges', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  assert.deepEqual(withDates({}, now), { startDate: '2026-10-01', endDate: '2026-10-10' });
  assert.throws(() => withDates({ startDate: '2026-10-05', endDate: '2026-10-01' }, now));
});

test('loadConfig rejects table names that could inject SQL', () => {
  assert.throws(() => loadConfig({ GCP_BILLING_EXPORT_TABLE: 'p.d.t` WHERE 1=1 --' }));
  assert.throws(() => loadConfig({ GCP_BILLING_EXPORT_TABLE: 'just_a_table' }));
});

test('explain maps common GCP errors to fixes', () => {
  assert.match(explain(new Error('Could not load the default credentials.')), /gcloud auth application-default login/);
  assert.match(explain(Object.assign(new Error('x'), { code: 7 })), /roles\/viewer/);
  assert.match(explain(new Error('Query exceeded limit for bytes billed: 5368709120')), /GCP_BQ_MAX_BYTES_BILLED/);
});

test('slow cost calls return "running", keep working, and the retry gets the cached result', async () => {
  const { backgroundJob } = await import('../src/server.js');
  let calls = 0;
  let release;
  const slow = backgroundJob(
    async (args) => {
      calls += 1;
      await new Promise((r) => (release = r));
      return { total: args.x * 2 };
    },
    { waitMs: 20, cacheMs: 60_000 },
  );

  const first = await slow({ x: 2 });
  assert.equal(first.status, 'running');
  release();
  assert.deepEqual(await slow({ x: 2 }), { total: 4 });
  assert.deepEqual(await slow({ x: 2 }), { total: 4 });
  assert.equal(calls, 1); // the retry reused the background work, then the cache

  const failing = backgroundJob(
    async () => {
      calls += 1;
      throw new Error('boom');
    },
    { waitMs: 1000, cacheMs: 60_000 },
  );
  await assert.rejects(failing({}), /boom/);
  await assert.rejects(failing({}), /boom/);
  assert.equal(calls, 3); // failures are retried, not cached
});

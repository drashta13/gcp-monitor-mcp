import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createInventoryService } from '../src/gcp/inventory.js';
import { createUsageService, summarize, seriesLabels, USAGE } from '../src/gcp/metrics.js';
import { createProjectScope } from '../src/gcp/util.js';

const NOW = Date.parse('2026-10-12T00:00:00Z');

async function connect({ assets = {}, series = () => [], allowed = ['a', 'b'] } = {}) {
  const calls = { search: [], list: [] };
  const assetClient = {
    async *searchAllResourcesAsync(req) {
      calls.search.push(req);
      const project = req.scope.split('/')[1];
      if (assets[project] instanceof Error) throw assets[project];
      yield* (assets[project] ?? []).filter((a) => req.assetTypes.includes(a.assetType));
    },
  };
  const metricClient = {
    listTimeSeries: async (req) => {
      calls.list.push(req);
      return [await series(req)];
    },
  };
  const projects = { list: async () => allowed.map((projectId) => ({ projectId })) };
  const scope = createProjectScope({ allowedProjects: allowed }, projects);
  const server = createServer({
    projects,
    billing: {},
    inventory: createInventoryService({ scope }, assetClient),
    usage: createUsageService({ scope }, metricClient, () => NOW),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(s), mcp.connect(c)]);
  return { mcp, calls };
}

const parse = (res) => {
  assert.ok(!res.isError, res.content[0].text);
  return JSON.parse(res.content[0].text);
};

const asset = (assetType, name, state, extra = {}) => ({
  assetType,
  name: `//x.googleapis.com/projects/p/${name}`,
  displayName: name,
  state,
  location: 'asia-south1',
  createTime: { seconds: 1760000000 },
  ...extra,
});

test('list_resources returns active resources across projects and counts the rest', async () => {
  const { mcp, calls } = await connect({
    assets: {
      a: [
        asset('compute.googleapis.com/Instance', 'vm-1', 'RUNNING'),
        asset('compute.googleapis.com/Instance', 'vm-old', 'TERMINATED'),
        asset('storage.googleapis.com/Bucket', 'assets-bucket', ''),
      ],
      b: [asset('sqladmin.googleapis.com/Instance', 'db-1', 'RUNNABLE')],
    },
  });
  const out = parse(await mcp.callTool({ name: 'list_resources', arguments: {} }));

  assert.deepEqual(out.counts, {
    vm: { active: 1, inactive: 1 },
    bucket: { active: 1, inactive: 0 },
    cloudsql: { active: 1, inactive: 0 },
  });
  assert.deepEqual(
    out.resources.map((r) => [r.kind, r.name, r.projectId, r.usageKind]),
    [
      ['bucket', 'assets-bucket', 'a', undefined],
      ['cloudsql', 'db-1', 'b', 'cloudsql'],
      ['vm', 'vm-1', 'a', 'vm'],
    ],
  );
  assert.equal(out.resources[2].created, '2025-10-09T08:53:20.000Z');
  assert.deepEqual(calls.search.map((r) => r.scope).sort(), ['projects/a', 'projects/b']);
  assert.ok(calls.search[0].assetTypes.includes('container.googleapis.com/Cluster'));

  const all = parse(
    await mcp.callTool({ name: 'list_resources', arguments: { kinds: ['vm'], includeInactive: true, projectIds: ['a'] } }),
  );
  assert.deepEqual(
    all.resources.map((r) => [r.name, r.active]),
    [
      ['vm-1', true],
      ['vm-old', false],
    ],
  );
  assert.deepEqual(calls.search.at(-1).assetTypes, ['compute.googleapis.com/Instance']);
});

test('list_resources reports a project that fails and rejects projects outside the allowlist', async () => {
  const { mcp } = await connect({
    assets: { a: [asset('compute.googleapis.com/Instance', 'vm-1', 'RUNNING')], b: new Error('7 PERMISSION_DENIED') },
  });
  const out = parse(await mcp.callTool({ name: 'list_resources', arguments: {} }));
  assert.equal(out.resources.length, 1);
  assert.deepEqual(out.failedProjects, [{ projectId: 'b', error: '7 PERMISSION_DENIED' }]);

  const denied = await mcp.callTool({ name: 'list_resources', arguments: { projectIds: ['zzz'] } });
  assert.ok(denied.isError);
});

const point = (v) => ({ value: typeof v === 'number' ? { doubleValue: v } : { int64Value: v } });

test('get_resource_usage aggregates per cluster with server-side grouping', async () => {
  const cluster = (name, values) => ({
    resource: { labels: { cluster_name: name, location: 'asia-south1' } },
    points: values.map(point),
  });
  const byMetric = {
    'kubernetes.io/container/cpu/core_usage_time': [cluster('prod', [2, 1, 3]), cluster('dev', [0.1])],
    'kubernetes.io/container/memory/used_bytes': [cluster('prod', [2 ** 30])],
    'kubernetes.io/pod/network/received_bytes_count': [cluster('prod', ['40', '38'])],
    'kubernetes.io/container/restart_count': [cluster('prod', ['1', '2'])],
    'kubernetes.io/node/cpu/allocatable_utilization': [cluster('prod', [0.5, 0.25])],
  };
  const { mcp, calls } = await connect({
    allowed: ['a'],
    series: (req) => byMetric[req.filter.match(/metric.type = "([^"]+)"/)[1]] ?? [],
  });
  const out = parse(await mcp.callTool({ name: 'get_resource_usage', arguments: { kind: 'gke', hours: 24 } }));

  assert.deepEqual(out.resources[0], {
    name: 'prod',
    location: 'asia-south1',
    projectId: 'a',
    metrics: {
      cpuCores: { avg: 2, max: 3, latest: 2 },
      memoryMiB: { avg: 1024, max: 1024, latest: 1024 },
      pods: { avg: 39, max: 40, latest: 40 },
      containerRestarts: { total: 3 },
      nodeCpuPercent: { avg: 37.5, max: 50, latest: 50 },
    },
  });
  assert.equal(out.resources[1].name, 'dev'); // sorted by cpuCores
  assert.equal(out.window.alignmentSeconds, 1800); // 24h / 48 points

  const cpu = calls.list.find((r) => r.filter.includes('core_usage_time'));
  assert.equal(cpu.name, 'projects/a');
  assert.deepEqual(cpu.aggregation, {
    alignmentPeriod: { seconds: 1800 },
    perSeriesAligner: 'ALIGN_RATE',
    crossSeriesReducer: 'REDUCE_SUM',
    groupByFields: ['resource.label.cluster_name', 'resource.label.location'],
  });
  assert.equal(cpu.interval.endTime.seconds - cpu.interval.startTime.seconds, 86400);
  const mem = calls.list.find((r) => r.filter.includes('memory/used_bytes'));
  assert.match(mem.filter, /AND metric.label.memory_type = "non-evictable"$/);
});

test('gke namespace breakdown skips node metrics and groups by namespace', async () => {
  const { mcp, calls } = await connect({
    allowed: ['a'],
    series: (req) =>
      req.filter.includes('core_usage_time')
        ? [{ resource: { labels: { cluster_name: 'prod', location: 'l', namespace_name: 'api' } }, points: [point(1)] }]
        : [],
  });
  const out = parse(
    await mcp.callTool({ name: 'get_resource_usage', arguments: { kind: 'gke', breakdown: 'namespace' } }),
  );
  assert.equal(out.resources[0].namespace, 'api');
  assert.ok(calls.list.every((r) => !r.filter.includes('kubernetes.io/node/')));
  assert.ok(calls.list.every((r) => r.aggregation.groupByFields.includes('resource.label.namespace_name')));
});

test('a metric type the project has never written counts as no data, not a failure', async () => {
  const notFound = Object.assign(new Error('3 INVALID_ARGUMENT: Cannot find metric(s) that match type'), { code: 3 });
  const { mcp } = await connect({
    allowed: ['a'],
    series: (req) => {
      if (req.filter.includes('agent.googleapis.com')) throw notFound;
      if (req.filter.includes('cpu/utilization'))
        return [{ metadata: { systemLabels: { fields: { name: { stringValue: 'vm-1' } } } }, resource: { labels: { zone: 'z' } }, points: [point(0.1)] }];
      return [];
    },
  });
  const out = parse(await mcp.callTool({ name: 'get_resource_usage', arguments: { kind: 'vm' } }));
  assert.deepEqual(out.resources, [
    { name: 'vm-1', location: 'z', projectId: 'a', metrics: { cpuPercent: { avg: 10, max: 10, latest: 10 } } },
  ]);
  assert.equal(out.failedProjects, undefined);
});

test('connections falls back from the PostgreSQL metric to the MySQL one', async () => {
  const db = (v) => [{ resource: { labels: { database_id: 'a:db-1', region: 'r' } }, points: [point(v)] }];
  const { mcp } = await connect({
    allowed: ['a'],
    series: (req) => (req.filter.includes('network/connections') ? db(12) : req.filter.includes('cpu') ? db(0.5) : []),
  });
  const out = parse(await mcp.callTool({ name: 'get_resource_usage', arguments: { kind: 'cloudsql' } }));
  assert.equal(out.resources[0].name, 'db-1');
  assert.deepEqual(out.resources[0].metrics.connections, { avg: 12, max: 12, latest: 12 });
  assert.deepEqual(out.resources[0].metrics.cpuPercent, { avg: 50, max: 50, latest: 50 });
});

test('every usage kind groups by fields its own key reads', () => {
  for (const [kind, spec] of Object.entries(USAGE)) {
    const labels = Object.fromEntries(spec.groupBy.map((f) => [f, 'x']));
    const key = spec.key(labels);
    assert.ok(key.name && key.location, kind);
    assert.ok(spec.metrics.some((m) => m.key === spec.sortBy), kind);
  }
});

test('helpers', () => {
  assert.equal(summarize([], { scale: 1, stat: 'series' }), null);
  assert.deepEqual(summarize([point('5'), point('3')], { scale: 1, stat: 'total' }), { total: 8 });
  assert.deepEqual(
    seriesLabels({ metric: { labels: { state: 'used' } } }, ['metric.label.state', 'resource.label.zone']),
    { 'metric.label.state': 'used', 'resource.label.zone': undefined },
  );
});

test('a metric the API rejects is reported in metricErrors instead of vanishing', async () => {
  const rejected = Object.assign(new Error('3 INVALID_ARGUMENT: aligner not supported for this metric kind'), { code: 3 });
  const { mcp } = await connect({
    allowed: ['a'],
    series: (req) => {
      if (req.filter.includes('restart_count')) throw rejected;
      if (req.filter.includes('core_usage_time'))
        return [{ resource: { labels: { cluster_name: 'prod', location: 'l' } }, points: [point(1)] }];
      return [];
    },
  });
  const out = parse(await mcp.callTool({ name: 'get_resource_usage', arguments: { kind: 'gke' } }));
  assert.deepEqual(out.metricErrors, [
    { projectId: 'a', metric: 'containerRestarts', type: 'kubernetes.io/container/restart_count', error: rejected.message },
  ]);
  assert.equal(out.resources[0].name, 'prod');
  assert.deepEqual(out.metrics.cpuCores, 'kubernetes.io/container/cpu/core_usage_time');
});

test('the echoed metrics map keeps both Cloud SQL connection metric types', async () => {
  const { mcp } = await connect({ allowed: ['a'] });
  const out = parse(await mcp.callTool({ name: 'get_resource_usage', arguments: { kind: 'cloudsql' } }));
  assert.deepEqual(out.metrics.connections, [
    'cloudsql.googleapis.com/database/postgresql/num_backends',
    'cloudsql.googleapis.com/database/network/connections',
  ]);
});

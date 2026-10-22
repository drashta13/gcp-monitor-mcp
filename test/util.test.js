import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRest, toError } from '../src/gcp/rest.js';
import { backgroundJob, explain } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createProjectScope, checkProjectIds, mapLimit, tally, fromMap } from '../src/gcp/util.js';
import { ConfigError } from '../src/gcp/errors.js';

// Fake google-auth client: `pages` is served in order; every request is recorded.
function fakeAuthClient(pages) {
  const calls = [];
  let i = 0;
  return {
    calls,
    request: async (opts) => {
      calls.push(opts);
      const page = pages[i++];
      if (page instanceof Error) throw page;
      return { data: page };
    },
  };
}

test('rest.list pages until max, flags truncation, and puts pageToken in the POST body', async () => {
  const client = fakeAuthClient([
    { entries: [1, 2], nextPageToken: 't1' },
    { entries: [3, 4], nextPageToken: 't2' },
    { entries: [5, 6], nextPageToken: 't3' },
  ]);
  const rest = createRest(client);
  const out = await rest.list('https://x/entries:list', { post: true, key: 'entries', max: 3, params: { filter: 'f' } });
  assert.deepEqual(out, { items: [1, 2, 3], truncated: true });
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[1].data, { filter: 'f', pageToken: 't1' });
  assert.equal(client.calls[1].method, 'POST');
  // Every request carries a timeout and retries POST too.
  assert.equal(client.calls[0].timeout, 60_000);
  assert.ok(client.calls[0].retryConfig.httpMethodsToRetry.includes('POST'));

  const exact = createRest(fakeAuthClient([{ items: [1, 2] }]));
  assert.deepEqual(await exact.list('https://x', { key: 'items', max: 2 }), { items: [1, 2], truncated: false });
});

test('rest.request maps a Google error body to a readable error that explain() understands', async () => {
  const gaxiosErr = Object.assign(new Error('Request failed with status code 403'), {
    response: { status: 403, data: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no compute.instances.list' } } },
    config: { headers: { Authorization: 'Bearer secret' } },
  });
  const rest = createRest(fakeAuthClient([gaxiosErr]));
  await assert.rejects(rest.get('https://x'), (err) => {
    assert.equal(err.message, '403 PERMISSION_DENIED: no compute.instances.list');
    assert.equal(err.code, 403);
    assert.equal(err.httpStatus, 403);
    assert.equal(err.cause, gaxiosErr);
    assert.match(explain(err), /Permission denied/);
    return true;
  });
  const plain = new Error('socket hang up');
  assert.equal(toError(plain), plain);
});

test('backgroundJob: identical calls share one run, distinct args run separately, cache expires', async () => {
  let t = 1000;
  const now = () => t;
  let calls = 0;
  let release;
  const slow = backgroundJob(
    async (args) => {
      calls += 1;
      await new Promise((r) => (release = r));
      return { x: args.x };
    },
    { waitMs: 20, cacheMs: 100, now },
  );
  const [a, b] = await Promise.all([slow({ x: 1 }), slow({ x: 1 })]);
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'running');
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await slow({ x: 1 }), { x: 1 });

  const other = slow({ x: 2 });
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await other, { x: 2 });
  assert.equal(calls, 2);

  t += 101; // past cacheMs: a fresh run
  const again = slow({ x: 1 });
  await new Promise((r) => setImmediate(r));
  release();
  await again;
  assert.equal(calls, 3);
});

test('backgroundJob: a job that fails after the caller stopped waiting reports the error on the next call', async () => {
  let calls = 0;
  let fail;
  const job = backgroundJob(
    async () => {
      calls += 1;
      await new Promise((_, reject) => (fail = reject));
    },
    { waitMs: 10, cacheMs: 60_000, what: 'collecting VM health' },
  );
  const first = await job({ a: 1 });
  assert.equal(first.status, 'running');
  assert.match(first.message, /still collecting VM health/);
  fail(new Error('bad filter'));
  await new Promise((r) => setImmediate(r));
  await assert.rejects(job({ a: 1 }), /bad filter/); // reported once...
  assert.equal(calls, 1);
  const retry = job({ a: 1 }); // ...then the next call starts over
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  fail(new Error('again'));
  await assert.rejects(retry, /again/);
});

test('loadConfig validates the bytes-billed cap and derives the query project from the table', () => {
  const TABLE = 'billing-proj.billing.gcp_billing_export_v1_0000AA_BBBBBB_CCCCCC';
  for (const bad of ['0', '-5', 'abc', '1.5']) {
    assert.throws(() => loadConfig({ GCP_BQ_MAX_BYTES_BILLED: bad }), /positive integer/, bad);
  }
  const cfg = loadConfig({ GCP_BILLING_EXPORT_TABLE: TABLE, GCP_BQ_MAX_BYTES_BILLED: '1024' });
  assert.equal(cfg.billingQueryProject, 'billing-proj');
  assert.equal(cfg.maxBytesBilled, 1024);
  assert.equal(loadConfig({ GCP_BILLING_EXPORT_TABLE: TABLE, GCP_BILLING_QUERY_PROJECT: 'q' }).billingQueryProject, 'q');
});

test('project scope: names only the denied ids, collapses duplicates, falls back to the project list', async () => {
  const list = async () => [{ projectId: 'seen-1' }, { projectId: 'seen-2' }];
  const allow = createProjectScope({ allowedProjects: ['prod-a', 'prod-b'] }, { list });
  await assert.rejects(allow(['prod-a', 'other-1', 'other-2']), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.message, 'Projects not in GCP_MONITOR_ALLOWED_PROJECTS: other-1, other-2');
    return true;
  });
  assert.deepEqual(await allow(['prod-b']), ['prod-b']);
  assert.deepEqual(await allow(['prod-b', 'prod-b', 'prod-a']), ['prod-b', 'prod-a']);
  assert.deepEqual(await allow(), ['prod-a', 'prod-b']);

  const open = createProjectScope({ allowedProjects: [] }, { list });
  assert.deepEqual(await open(), ['seen-1', 'seen-2']);
  assert.deepEqual(await open(['x-1', 'x-1']), ['x-1']);
});

test('project IDs that could change a request path are refused everywhere', () => {
  for (const bad of ['../../x?y=1#', 'Prod', 'a b', 'ends-', '-starts', 'x'.repeat(31), 'google.com:legacy']) {
    assert.throws(() => checkProjectIds([bad]), /Not a valid project ID/, bad);
  }
  assert.deepEqual(checkProjectIds(['fs-life-prod', 'p1', 'a']), ['fs-life-prod', 'p1', 'a']);
});

test('mapLimit treats a synchronous throw as a rejection and keeps order', async () => {
  const out = await mapLimit([1, 2, 3], 2, (x) => {
    if (x === 2) throw new Error('sync');
    return Promise.resolve(x * 10);
  });
  assert.deepEqual(
    out.map((r) => r.status + ':' + (r.value ?? r.reason.message)),
    ['fulfilled:10', 'rejected:sync', 'fulfilled:30'],
  );
});

test('tally/fromMap keep remote-controlled keys off Object.prototype', () => {
  const m = new Map();
  tally(m, '__proto__');
  tally(m, 'constructor');
  const o = fromMap(m);
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.equal(Object.hasOwn(o, '__proto__'), true);
  assert.equal(o.constructor, 1);
  assert.equal({}.__proto__.constructor, Object); // untouched
  assert.equal(JSON.parse(JSON.stringify(o))['__proto__'], 1);
});

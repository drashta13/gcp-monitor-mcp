import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqlHealthService } from '../src/gcp/sqlhealth.js';
import { createGkeHealthService } from '../src/gcp/gkehealth.js';
import { createVmHealthService } from '../src/gcp/vmhealth.js';
import { createIncidentsService } from '../src/gcp/incidents.js';
import { createLogsService } from '../src/gcp/logs.js';
import { createProjectScope, perProject } from '../src/gcp/util.js';
import { describe as describeVm } from '../src/gcp/vmhealth.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const scope = createProjectScope({ allowedProjects: ['p'] }, { list: async () => [] });

// Fake REST client: routes(url, params) returns the response body; every call is recorded.
function fakeRest(routes) {
  const calls = [];
  const respond = async (url, params) => {
    calls.push({ url, params });
    const body = await routes(url, params ?? {});
    if (body instanceof Error) throw body;
    return body;
  };
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

const fakeUsage = (resources) => ({
  usage: async (args) => ({ kind: args.kind, resources: resources[args.kind] ?? [] }),
});

test('cloudsql health flags missing HA, PITR, stale backups and full disks', async () => {
  const rest = fakeRest((url) => {
    if (url.endsWith('/projects/p/instances'))
      return {
        items: [
          {
            name: 'fsdev',
            state: 'RUNNABLE',
            databaseVersion: 'POSTGRES_15',
            region: 'asia-south1',
            gceZone: 'asia-south1-a',
            instanceType: 'CLOUD_SQL_INSTANCE',
            settings: {
              tier: 'db-custom-4-16384',
              availabilityType: 'ZONAL',
              backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: false },
              storageAutoResize: true,
              deletionProtectionEnabled: true,
              dataDiskSizeGb: '100',
            },
          },
          {
            name: 'prod-db',
            state: 'RUNNABLE',
            instanceType: 'CLOUD_SQL_INSTANCE',
            secondaryGceZone: 'asia-south1-b',
            settings: {
              availabilityType: 'REGIONAL',
              backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true, transactionLogRetentionDays: 7 },
              deletionProtectionEnabled: true,
              maintenanceWindow: { day: 7, hour: 20 },
            },
          },
        ],
      };
    if (url.includes('/fsdev/backupRuns'))
      return {
        items: [
          { status: 'SUCCESSFUL', endTime: '2026-10-11T00:00:00Z' },
          { status: 'FAILED', startTime: '2026-10-10T00:00:00Z', error: { message: 'disk full' } },
        ],
      };
    if (url.includes('/prod-db/backupRuns'))
      return { items: [{ status: 'SUCCESSFUL', endTime: '2026-10-14T02:00:00Z' }] };
  });
  const usage = fakeUsage({
    cloudsql: [
      {
        name: 'fsdev',
        projectId: 'p',
        metrics: { diskPercent: { avg: 88, max: 90, latest: 90 }, uptimePercent: { avg: 100 } },
      },
    ],
  });
  const svc = createSqlHealthService({ scope, rest, usage, now: () => NOW });
  const out = await svc.health({});

  assert.equal(out.summary.instances, 2);
  const [fsdev, prod] = out.instances;
  assert.equal(fsdev.name, 'fsdev'); // most issues first
  assert.deepEqual(fsdev.issues, [
    'no high availability (zonal): no automatic failover',
    'point-in-time recovery is off',
    'last successful backup was 84h ago',
    '1 failed backup run(s) recently',
    'disk 90% full',
  ]);
  assert.equal(fsdev.metrics.diskPercent.latest, 90);
  assert.deepEqual(prod.issues, []);
  assert.equal(prod.highAvailability, true);
  assert.deepEqual(prod.maintenance.window, { day: 7, hourUtc: 20 });
});

test('gke health reads clusters, warning events and autoscaler decisions', async () => {
  const rest = fakeRest((url, params) => {
    if (url.includes('/locations/-/clusters'))
      return {
        clusters: [
          {
            name: 'fs-storefront-web',
            location: 'asia-south1',
            status: 'RUNNING',
            currentMasterVersion: '1.30.5-gke.1',
            currentNodeVersion: '1.29.8-gke.2',
            releaseChannel: { channel: 'REGULAR' },
            nodePools: [
              {
                name: 'default',
                version: '1.29.8-gke.2',
                status: 'RUNNING',
                autoscaling: { enabled: true, minNodeCount: 1, maxNodeCount: 5 },
                management: { autoUpgrade: true, autoRepair: true },
                config: { machineType: 'e2-standard-4' },
              },
            ],
          },
        ],
      };
    if (params.filter?.includes('logs/events'))
      return {
        entries: [
          { resource: { labels: { cluster_name: 'fs-storefront-web' } }, jsonPayload: { reason: 'OOMKilling' } },
          { resource: { labels: { cluster_name: 'fs-storefront-web' } }, jsonPayload: { reason: 'BackOff' } },
          { resource: { labels: { cluster_name: 'fs-storefront-web' } }, jsonPayload: { reason: 'BackOff' } },
        ],
      };
    if (params.filter?.includes('cluster-autoscaler'))
      return {
        entries: [
          { resource: { labels: { cluster_name: 'fs-storefront-web' } }, jsonPayload: { decision: { scaleUp: {} } } },
          { resource: { labels: { cluster_name: 'fs-storefront-web' } }, jsonPayload: { decision: { scaleDown: {} } } },
        ],
      };
  });
  const usage = fakeUsage({
    gke: [{ name: 'fs-storefront-web', projectId: 'p', metrics: { containerRestarts: { total: 14 } } }],
  });
  const out = await createGkeHealthService({ scope, rest, usage, now: () => NOW }).health({ hours: 24 });

  const c = out.clusters[0];
  assert.deepEqual(c.events, { OOMKilling: 1, BackOff: 2 });
  assert.deepEqual(c.autoscaling, { scaleUp: 1, scaleDown: 1 });
  assert.deepEqual(c.nodePools[0].nodes, { autoscaling: true, min: 1, max: 5 });
  assert.deepEqual(c.issues, [
    'node pool default on 1.29.8-gke.2, control plane on 1.30.5-gke.1',
    '1 OOM kill event(s)',
    '2 crash-loop back-off event(s)',
    '14 container restarts',
  ]);
  const logCall = rest.calls.find((x) => x.params?.filter?.includes('logs/events'));
  assert.deepEqual(logCall.params.resourceNames, ['projects/p']);
  assert.match(logCall.params.filter, /timestamp>="2026-10-13T12:00:00.000Z"/);
});

test('gke health still reports clusters when the log query fails', async () => {
  const rest = fakeRest((url) =>
    url.includes('clusters')
      ? { clusters: [{ name: 'c', status: 'RUNNING', releaseChannel: { channel: 'STABLE' } }] }
      : new Error('403 PERMISSION_DENIED'),
  );
  const out = await createGkeHealthService({ scope, rest, usage: fakeUsage({}), now: () => NOW }).health({});
  assert.deepEqual(out.clusters[0].events, { error: '403 PERMISSION_DENIED' });
  assert.deepEqual(out.clusters[0].issues, []);
});

test('vm health joins disks, snapshots, schedules, OS Config and agent metrics', async () => {
  const disk = (name, extra = {}) => ({
    name,
    selfLink: `https://compute/projects/p/zones/z1/disks/${name}`,
    zone: 'https://compute/projects/p/zones/z1',
    sizeGb: '50',
    type: 'https://compute/pd-balanced',
    users: ['vm'],
    ...extra,
  });
  const rest = fakeRest((url) => {
    if (url.endsWith('/aggregated/instances'))
      return {
        items: {
          'zones/z1': {
            instances: [
              {
                id: '111',
                name: 'web-1',
                zone: 'https://compute/projects/p/zones/z1',
                status: 'RUNNING',
                machineType: 'https://compute/machineTypes/e2-medium',
                disks: [{ source: disk('web-1-boot').selfLink }],
              },
              {
                id: '222',
                name: 'batch-1',
                zone: 'https://compute/projects/p/zones/z1',
                status: 'RUNNING',
                machineType: 'https://compute/machineTypes/e2-small',
                disks: [{ source: disk('batch-1-boot').selfLink }],
              },
            ],
          },
          'zones/z2': { warning: { code: 'NO_RESULTS_ON_PAGE' } },
        },
      };
    if (url.endsWith('/aggregated/disks'))
      return {
        items: {
          'zones/z1': {
            disks: [
              disk('web-1-boot', { resourcePolicies: ['https://compute/policies/daily'] }),
              disk('batch-1-boot'),
              disk('orphan', { users: undefined }),
            ],
          },
        },
      };
    if (url.endsWith('/global/snapshots'))
      return {
        items: [
          { status: 'READY', sourceDisk: disk('batch-1-boot').selfLink, creationTimestamp: '2026-09-01T00:00:00Z' },
        ],
      };
    if (url.endsWith('/aggregated/resourcePolicies'))
      return {
        items: {
          'regions/r': {
            resourcePolicies: [{ selfLink: 'https://compute/policies/daily', snapshotSchedulePolicy: {} }],
          },
        },
      };
    if (url.endsWith('/inventories'))
      return {
        inventories: [
          {
            name: 'projects/p/locations/z1/instances/111/inventory',
            updateTime: '2026-10-14T06:00:00Z',
            osInfo: { longName: 'Debian 12', version: '12' },
          },
        ],
      };
    if (url.endsWith('/vulnerabilityReports'))
      return {
        vulnerabilityReports: [
          {
            name: 'projects/p/locations/z1/instances/111/vulnerabilityReport',
            vulnerabilities: [
              { details: { severity: 'CRITICAL' } },
              { details: { severity: 'HIGH' } },
              { details: { severity: 'HIGH' } },
            ],
          },
        ],
      };
  });
  const usage = fakeUsage({
    vm: [
      {
        name: 'web-1',
        projectId: 'p',
        metrics: { opsAgent: { reporting: true }, diskPercent: { avg: 70, max: 91, latest: 91 } },
      },
    ],
  });
  const out = await createVmHealthService({ scope, rest, usage, now: () => NOW }).health({});

  assert.equal(out.summary.vms, 2);
  const web = out.vms.find((v) => v.name === 'web-1');
  const batch = out.vms.find((v) => v.name === 'batch-1');
  assert.deepEqual(web.agents, { osConfig: true, opsAgent: true });
  assert.deepEqual(web.patches.vulnerabilities, { CRITICAL: 1, HIGH: 2 });
  assert.equal(web.disks[0].snapshotSchedule, true);
  assert.deepEqual(web.issues, [
    '1 critical vulnerabilities (OS patches missing)',
    '2 high vulnerabilities',
    'disk 91% full',
  ]);
  assert.deepEqual(batch.issues, [
    'disk batch-1-boot: no snapshot schedule and last snapshot 43d ago',
    'OS Config agent not reporting (no patch or OS data)',
    'Ops Agent not reporting (no memory or disk metrics)',
  ]);
  assert.deepEqual(out.unattachedDisks, [{ name: 'orphan', projectId: 'p', zone: 'z1', sizeGb: 50 }]);
});

test('incidents merges alerts, Google Cloud events and uptime availability', async () => {
  const rest = fakeRest((url) => {
    if (url.endsWith('/alerts'))
      return {
        alerts: [
          {
            state: 'OPEN',
            openTime: '2026-10-14T11:00:00Z',
            policy: { displayName: 'High CPU', severity: 'WARNING' },
            resource: { type: 'cloudsql_database', labels: { database_id: 'p:fsdev' } },
            metric: { type: 'cloudsql.googleapis.com/database/cpu/utilization' },
          },
          {
            state: 'CLOSED',
            openTime: '2026-10-12T10:00:00Z',
            closeTime: '2026-10-12T10:30:00Z',
            policy: { displayName: 'High CPU' },
            resource: { type: 'cloudsql_database', labels: { database_id: 'p:fsdev' } },
          },
          {
            state: 'CLOSED',
            openTime: '2026-09-01T00:00:00Z',
            closeTime: '2026-09-01T01:00:00Z',
            policy: { displayName: 'Old' },
          },
        ],
      };
    if (url.includes('servicehealth')) return new Error('403 SERVICE_DISABLED: Service Health API has not been used');
  });
  const usage = fakeUsage({ uptime: [{ name: 'storefront-https', metrics: { availabilityPercent: { avg: 99.5 } } }] });
  const out = await createIncidentsService({ scope, rest, usage, now: () => NOW }).incidents({ hours: 168 });

  assert.deepEqual(out.summary, { incidents: 2, open: 1, googleCloudEvents: null, uptimeChecks: 1 });
  assert.deepEqual(out.byPolicy, [{ policy: 'High CPU', severity: 'WARNING', count: 2, open: 1, totalMinutes: 90 }]);
  assert.equal(out.incidents[0].resource.name, 'fsdev');
  assert.equal(out.incidents[1].durationMinutes, 30);
  assert.match(out.googleCloudEvents.unavailable, /SERVICE_DISABLED/);
  assert.equal(out.availability[0].name, 'storefront-https');
});

test('query_logs combines preset, filter and resource name and trims entries', async () => {
  const rest = fakeRest(() => ({
    entries: [
      {
        timestamp: '2026-10-14T11:00:00Z',
        severity: 'ERROR',
        logName: 'projects/p/logs/stderr',
        resource: { type: 'k8s_container', labels: { cluster_name: 'web', namespace_name: 'shop', pod_name: 'api-1' } },
        textPayload: 'panic: nil pointer',
      },
      {
        timestamp: '2026-10-14T10:00:00Z',
        severity: 'NOTICE',
        logName: 'projects/p/logs/cloudaudit.googleapis.com%2Factivity',
        resource: { type: 'gke_cluster', labels: { cluster_name: 'web' } },
        protoPayload: {
          methodName: 'google.container.v1.ClusterManager.UpdateCluster',
          authenticationInfo: { principalEmail: 'dev@x.com' },
        },
      },
    ],
  }));
  const out = await createLogsService({ scope, rest, now: () => NOW }).query({
    preset: 'errors',
    filter: 'resource.type="k8s_container"',
    resourceName: 'web',
    hours: 6,
    limit: 10,
  });
  assert.equal(
    out.filter,
    'timestamp>="2026-10-14T06:00:00.000Z" AND severity>=ERROR AND (resource.type="k8s_container") AND "web"',
  );
  assert.equal(out.entries[0].resource.name, 'web/shop/api-1');
  assert.equal(out.entries[0].message, 'panic: nil pointer');
  assert.equal(out.entries[1].log, 'cloudaudit.googleapis.com/activity');
  assert.deepEqual(out.entries[1].audit, {
    method: 'google.container.v1.ClusterManager.UpdateCluster',
    principal: 'dev@x.com',
    resource: undefined,
  });
  assert.deepEqual(out.bySeverity, { ERROR: 1, NOTICE: 1 });
});

test('perProject: a disabled API means the project does not use the service, not a failure', async () => {
  const out = await perProject(['a', 'b', 'c'], 2, async (id) => {
    if (id === 'b') throw new Error('403 PERMISSION_DENIED: Compute Engine API has not been used in project b');
    if (id === 'c') throw new Error('500 INTERNAL: boom');
    return id;
  });
  assert.deepEqual(out, { ok: ['a'], failed: [{ projectId: 'c', error: '500 INTERNAL: boom' }], apiNotEnabled: ['b'] });
  const none = await perProject(['b'], 1, async () => {
    throw new Error('403 SERVICE_DISABLED');
  });
  assert.deepEqual(none, { ok: [], failed: [], apiNotEnabled: ['b'] });
});

test('vm describe: VM Manager off in the project is not a per-VM agent issue', () => {
  const row = describeVm({
    projectId: 'p',
    vm: { name: 'vm1', status: 'RUNNING', zone: 'z/us-a' },
    disks: [],
    lastSnapshot: new Map(),
    scheduleNames: new Set(),
    metrics: { opsAgent: { reporting: true } },
    vmManagerOff: true,
    nowMs: NOW,
  });
  assert.deepEqual(row.issues, []);
  assert.equal(row.agents.osConfig, 'VM Manager off in project');
});

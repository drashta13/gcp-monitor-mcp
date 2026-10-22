import { projectNotes, perProject, mapLimit, tally, fromMap, metricsWithoutResource } from './util.js';
import { seg } from './rest.js';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const OSCONFIG = 'https://osconfig.googleapis.com/v1';
const DAY = 86_400_000;
const MAX_AGGREGATED = 10_000; // instances or disks per project
const GKE_NODE_LABEL = 'goog-gke-node';

export const THRESHOLDS = {
  snapshotAgeDays: 7, // a disk with no schedule and no snapshot newer than this
  osConfigAgeHours: 48, // OS Config inventory older than this is stale
  diskPercent: 85, // latest
  memoryPercent: 90, // average
  cpuPercent: 85, // average
};

// VM health: state and disks from Compute, snapshot coverage (recent snapshots and snapshot schedules),
// OS patch status and agent health from OS Config (vulnerability reports and inventory), and CPU / memory /
// disk from Monitoring. roles/viewer covers all of it, including the OS Config inventory and
// vulnerability report reads.
export function createVmHealthService({ scope, rest, usage, now = Date.now }) {
  async function aggregatedList(url, field) {
    const out = [];
    let pageToken;
    let truncated = false;
    do {
      const data = await rest.get(url, { maxResults: 500, pageToken, returnPartialSuccess: true });
      for (const scoped of Object.values(data?.items ?? {})) out.push(...(scoped[field] ?? []));
      pageToken = data?.nextPageToken;
      if (pageToken && out.length >= MAX_AGGREGATED) {
        truncated = true;
        break;
      }
    } while (pageToken);
    return Object.assign(out, { truncated });
  }

  async function osInfo(projectId, zones) {
    // Keyed by "zone/instance" from OS Config resource names: Maps, since the names come from the API.
    const inventories = new Map();
    const vulns = new Map();
    let error = null;
    await mapLimit(zones, 4, async (zone) => {
      const base = `${OSCONFIG}/projects/${seg(projectId)}/locations/${seg(zone)}/instances/-`;
      const [inv, rep] = await Promise.all([
        rest.list(`${base}/inventories`, { key: 'inventories', params: { view: 'BASIC', pageSize: 100 } }),
        rest.list(`${base}/vulnerabilityReports`, { key: 'vulnerabilityReports', params: { pageSize: 100 } }),
      ]).catch((err) => {
        error ??= err.message;
        return [{ items: [] }, { items: [] }];
      });
      for (const i of inv.items) inventories.set(instanceKey(i.name), i);
      for (const r of rep.items) vulns.set(instanceKey(r.name), r);
    });
    return { inventories, vulns, error };
  }

  async function forProject(projectId) {
    const p = seg(projectId);
    const [instances, disks, snapshots, policies] = await Promise.all([
      aggregatedList(`${COMPUTE}/projects/${p}/aggregated/instances`, 'instances'),
      aggregatedList(`${COMPUTE}/projects/${p}/aggregated/disks`, 'disks'),
      rest
        .list(`${COMPUTE}/projects/${p}/global/snapshots`, {
          key: 'items',
          max: 5000,
          params: { maxResults: 500 },
        })
        .then((r) => r.items),
      aggregatedList(`${COMPUTE}/projects/${p}/aggregated/resourcePolicies`, 'resourcePolicies').catch(() => []),
    ]);
    const zones = [...new Set(instances.map((i) => last(i.zone)))];
    const os = await osInfo(projectId, zones);
    return { projectId, instances, disks, snapshots, policies, os };
  }

  return {
    async health({ projectIds, names, hours = 24, endTime, includeGkeNodes = false, limit = 100 }) {
      const ids = await scope(projectIds);
      const [config, metrics] = await Promise.all([
        perProject(ids, 4, forProject),
        // Every VM's metrics: they are joined to the VM list below, and a cap would cut off the idle ones.
        usage.usage({ kind: 'vm', projectIds: ids, hours, endTime, limit: Infinity }).catch((err) => ({ error: err.message })),
      ]);
      const metricsByName = new Map((metrics.resources ?? []).map((r) => [`${r.projectId}/${r.name}`, r.metrics]));

      const rows = [];
      const osConfigOff = [];
      const listTruncatedIn = [];
      let osError = null;
      let gkeNodesSkipped = 0;
      // A past window (endTime): VMs created after it didn't exist yet, and VMs that existed then but are
      // gone now still have their metrics reported, under notFoundNow.
      const windowEndMs = endTime ? Date.parse(endTime) : null;
      const seen = new Set();
      for (const { projectId, instances, disks, snapshots, policies, os } of config.ok) {
        // "OS inventory management has been disabled": VM Manager is off for the whole project.
        const vmManagerOff = /has been disabled|FAILED_PRECONDITION/.test(os.error ?? '');
        if (vmManagerOff) osConfigOff.push(projectId);
        else osError ??= os.error;
        if (instances.truncated || disks.truncated) listTruncatedIn.push(projectId);
        const diskByUrl = new Map(disks.map((d) => [d.selfLink, d]));
        const lastSnapshot = latestSnapshotByDisk(snapshots);
        const scheduleNames = new Set(policies.filter((p) => p.snapshotSchedulePolicy).map((p) => p.selfLink));
        for (const vm of instances) {
          seen.add(`${projectId}/${vm.name}`);
          if (names?.length && !names.includes(vm.name)) continue;
          if (windowEndMs && Date.parse(vm.creationTimestamp) >= windowEndMs) continue;
          // GKE nodes are managed by GKE: no snapshot schedules, OS Config or Ops Agent by design, so every
          // one of them would otherwise top the list with three issues it can't fix.
          if (!includeGkeNodes && isGkeNode(vm)) {
            gkeNodesSkipped += 1;
            continue;
          }
          const key = `${last(vm.zone)}/`;
          rows.push(
            describe({
              projectId,
              vm,
              disks: (vm.disks ?? []).map(
                (d) => diskByUrl.get(d.source) ?? { selfLink: d.source, name: last(d.source) },
              ),
              lastSnapshot,
              scheduleNames,
              inventory: os.inventories.get(`${key}${vm.id}`) ?? os.inventories.get(`${key}${vm.name}`),
              vulns: os.vulns.get(`${key}${vm.id}`) ?? os.vulns.get(`${key}${vm.name}`),
              metrics: metricsByName.get(`${projectId}/${vm.name}`),
              vmManagerOff,
              nowMs: now(),
            }),
          );
        }
      }
      rows.sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));

      const unattachedDisks = config.ok.flatMap(({ projectId, disks }) =>
        disks
          .filter((d) => !d.users?.length)
          .map((d) => ({ name: d.name, projectId, zone: last(d.zone ?? d.region), sizeGb: Number(d.sizeGb) })),
      );

      const notFoundNow =
        windowEndMs && !names?.length
          ? metricsWithoutResource(metricsByName, seen).filter((r) => !isManagedNodeName(r.name, includeGkeNodes))
          : [];

      return {
        window: { hours, ...(endTime ? { end: endTime } : {}) },
        summary: {
          vms: rows.length,
          running: rows.filter((r) => r.status === 'RUNNING').length,
          withIssues: rows.filter((r) => r.issues.length).length,
          unattachedDisks: unattachedDisks.length,
          ...(gkeNodesSkipped ? { gkeNodesSkipped } : {}),
        },
        returned: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        vms: rows.slice(0, limit),
        unattachedDisks,
        ...(notFoundNow.length ? { notFoundNow } : {}),
        notes:
          'Patch status comes from OS Config vulnerability reports and agent health from OS Config inventory ' +
          'and Ops Agent metrics; VMs without those agents show them as missing.',
        ...(listTruncatedIn.length
          ? { listTruncatedIn, listNote: `Only the first ${MAX_AGGREGATED} instances/disks per project were read.` }
          : {}),
        ...(osConfigOff.length
          ? {
              vmManagerOffIn: osConfigOff,
              vmManagerNote:
                'OS patch status and OS inventory are unavailable in these projects because VM Manager (OS Config) ' +
                'is not enabled: https://cloud.google.com/compute/docs/manage-os#enable-full-vmm',
            }
          : {}),
        ...(osError ? { osConfigError: osError } : {}),
        ...(metrics.error ? { metricsError: metrics.error } : {}),
        ...(metrics.metricErrors ? { metricErrors: metrics.metricErrors } : {}),
        ...projectNotes(config),
      };
    },
  };
}

export const isGkeNode = (vm) => vm.labels?.[GKE_NODE_LABEL] != null;

// VMs Google creates and replaces on its own, recognised by name when only their metrics are left: GKE nodes
// (standard "gke-", Autopilot "gk3-"; kept with includeGkeNodes) and Serverless VPC Access connector
// instances ("aet-"). Autopilot replaces nodes daily, so without this a past day lists dozens of them.
export const isManagedNodeName = (name, includeGkeNodes = false) =>
  /^gk[e3]-/.test(name ?? '') ? !includeGkeNodes : /^aet-/.test(name ?? '');


export function describe({
  projectId,
  vm,
  disks,
  lastSnapshot,
  scheduleNames,
  inventory,
  vulns,
  metrics,
  vmManagerOff = false,
  nowMs,
}) {
  const running = vm.status === 'RUNNING';
  const diskRows = disks.map((d) => {
    const snap = lastSnapshot.get(d.selfLink);
    const scheduled = (d.resourcePolicies ?? []).some((p) => scheduleNames.has(p));
    return {
      name: d.name,
      sizeGb: Number(d.sizeGb) || null,
      type: last(d.type),
      lastSnapshot: snap ?? null,
      snapshotAgeDays: snap ? Math.floor((nowMs - Date.parse(snap)) / DAY) : null,
      snapshotSchedule: scheduled,
    };
  });

  const counts = vulnCounts(vulns);
  const osAgeHours = inventory?.updateTime ? (nowMs - Date.parse(inventory.updateTime)) / 3600_000 : null;

  const issues = [];
  if (!running) issues.push(`status ${vm.status}`);
  for (const d of diskRows) {
    if (!d.snapshotSchedule && (d.snapshotAgeDays == null || d.snapshotAgeDays > THRESHOLDS.snapshotAgeDays))
      issues.push(
        `disk ${d.name}: no snapshot schedule and ${d.lastSnapshot ? `last snapshot ${d.snapshotAgeDays}d ago` : 'no snapshots'}`,
      );
  }
  if (running) {
    if (!inventory && !vmManagerOff) issues.push('OS Config agent not reporting (no patch or OS data)');
    else if (inventory && osAgeHours > THRESHOLDS.osConfigAgeHours)
      issues.push(`OS Config data is ${Math.round(osAgeHours)}h old`);
    if (!metrics?.opsAgent) issues.push('Ops Agent not reporting (no memory or disk metrics)');
  }
  if (counts.CRITICAL) issues.push(`${counts.CRITICAL} critical vulnerabilities (OS patches missing)`);
  if (counts.HIGH) issues.push(`${counts.HIGH} high vulnerabilities`);
  if (metrics?.diskPercent?.latest >= THRESHOLDS.diskPercent) issues.push(`disk ${metrics.diskPercent.latest}% full`);
  if (metrics?.memoryPercent?.avg >= THRESHOLDS.memoryPercent)
    issues.push(`memory averaging ${metrics.memoryPercent.avg}%`);
  if (metrics?.cpuPercent?.avg >= THRESHOLDS.cpuPercent) issues.push(`CPU averaging ${metrics.cpuPercent.avg}%`);

  const os = inventory?.osInfo;
  return {
    name: vm.name,
    projectId,
    zone: last(vm.zone),
    status: vm.status,
    machineType: last(vm.machineType),
    lastStart: vm.lastStartTimestamp ?? null,
    ...(isGkeNode(vm) ? { gkeNode: true } : {}),
    os: os
      ? {
          name: os.longName ?? os.shortName,
          version: os.version,
          kernel: os.kernelRelease,
          updated: inventory.updateTime,
        }
      : null,
    patches: vulns ? { vulnerabilities: counts, reportUpdated: vulns.updateTime } : null,
    agents: { osConfig: vmManagerOff ? 'VM Manager off in project' : Boolean(inventory), opsAgent: Boolean(metrics?.opsAgent) },
    disks: diskRows,
    metrics: metrics ?? null,
    issues,
  };
}

// Newest READY snapshot per source disk. Timestamps are compared as instants: Compute's RFC 3339 strings
// carry a local offset, so lexical order is not chronological order.
function latestSnapshotByDisk(snapshots) {
  const out = new Map();
  for (const s of snapshots) {
    if (s.status !== 'READY' || !s.sourceDisk) continue;
    const prev = out.get(s.sourceDisk);
    if (!prev || Date.parse(s.creationTimestamp) > Date.parse(prev)) out.set(s.sourceDisk, s.creationTimestamp);
  }
  return out;
}

// Severity strings come from the report: count in a Map.
function vulnCounts(report) {
  const out = new Map();
  for (const v of report?.vulnerabilities ?? []) tally(out, v.details?.severity ?? 'UNKNOWN');
  return fromMap(out);
}

// OS Config names: projects/{p}/locations/{zone}/instances/{id or name}/inventory -> "zone/instance".
function instanceKey(name) {
  const m = name.match(/locations\/([^/]+)\/instances\/([^/]+)/);
  return m ? `${m[1]}/${m[2]}` : name;
}

const last = (url) => (url ? String(url).split('/').pop() : null);

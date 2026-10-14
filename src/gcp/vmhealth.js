import { projectNotes, perProject, mapLimit } from './util.js';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const OSCONFIG = 'https://osconfig.googleapis.com/v1';
const DAY = 86_400_000;

// VM health: state and disks from Compute, snapshot coverage (recent snapshots and snapshot schedules),
// OS patch status and agent health from OS Config (vulnerability reports and inventory), and CPU / memory /
// disk from Monitoring. roles/viewer covers all of it, including the OS Config inventory and
// vulnerability report reads.
export function createVmHealthService({ scope, rest, usage, now = Date.now }) {
  async function aggregatedList(url, field) {
    const out = [];
    let pageToken;
    do {
      const data = await rest.get(url, { maxResults: 500, pageToken, returnPartialSuccess: true });
      for (const scoped of Object.values(data?.items ?? {})) out.push(...(scoped[field] ?? []));
      pageToken = data?.nextPageToken;
    } while (pageToken && out.length < 10_000);
    return out;
  }

  async function osInfo(projectId, zones) {
    const inventories = {};
    const vulns = {};
    let error = null;
    await mapLimit(zones, 4, async (zone) => {
      const base = `${OSCONFIG}/projects/${projectId}/locations/${zone}/instances/-`;
      const [inv, rep] = await Promise.all([
        rest.list(`${base}/inventories`, { key: 'inventories', params: { view: 'BASIC', pageSize: 100 } }),
        rest.list(`${base}/vulnerabilityReports`, { key: 'vulnerabilityReports', params: { pageSize: 100 } }),
      ]).catch((err) => {
        error ??= err.message;
        return [{ items: [] }, { items: [] }];
      });
      for (const i of inv.items) inventories[instanceKey(i.name)] = i;
      for (const r of rep.items) vulns[instanceKey(r.name)] = r;
    });
    return { inventories, vulns, error };
  }

  async function forProject(projectId) {
    const [instances, disks, snapshots, policies] = await Promise.all([
      aggregatedList(`${COMPUTE}/projects/${projectId}/aggregated/instances`, 'instances'),
      aggregatedList(`${COMPUTE}/projects/${projectId}/aggregated/disks`, 'disks'),
      rest
        .list(`${COMPUTE}/projects/${projectId}/global/snapshots`, {
          key: 'items',
          max: 5000,
          params: { maxResults: 500 },
        })
        .then((r) => r.items),
      aggregatedList(`${COMPUTE}/projects/${projectId}/aggregated/resourcePolicies`, 'resourcePolicies').catch(
        () => [],
      ),
    ]);
    const zones = [...new Set(instances.map((i) => last(i.zone)))];
    const os = await osInfo(projectId, zones);
    return { projectId, instances, disks, snapshots, policies, os };
  }

  return {
    async health({ projectIds, names, hours = 24 }) {
      const ids = await scope(projectIds);
      const [config, metrics] = await Promise.all([
        perProject(ids, 4, forProject),
        usage.usage({ kind: 'vm', projectIds: ids, hours, limit: 200 }).catch((err) => ({ error: err.message })),
      ]);
      const metricsByName = new Map((metrics.resources ?? []).map((r) => [`${r.projectId}/${r.name}`, r.metrics]));

      const rows = [];
      const osConfigOff = [];
      let osError = null;
      for (const { projectId, instances, disks, snapshots, policies, os } of config.ok) {
        // "OS inventory management has been disabled": VM Manager is off for the whole project.
        const vmManagerOff = /has been disabled|FAILED_PRECONDITION/.test(os.error ?? '');
        if (vmManagerOff) osConfigOff.push(projectId);
        else osError ??= os.error;
        const diskByUrl = new Map(disks.map((d) => [d.selfLink, d]));
        const lastSnapshot = latestSnapshotByDisk(snapshots);
        const scheduleNames = new Set(policies.filter((p) => p.snapshotSchedulePolicy).map((p) => p.selfLink));
        for (const vm of instances) {
          if (names?.length && !names.includes(vm.name)) continue;
          rows.push(
            describe({
              projectId,
              vm,
              disks: (vm.disks ?? []).map(
                (d) => diskByUrl.get(d.source) ?? { selfLink: d.source, name: last(d.source) },
              ),
              lastSnapshot,
              scheduleNames,
              inventory: os.inventories[`${last(vm.zone)}/${vm.id}`] ?? os.inventories[`${last(vm.zone)}/${vm.name}`],
              vulns: os.vulns[`${last(vm.zone)}/${vm.id}`] ?? os.vulns[`${last(vm.zone)}/${vm.name}`],
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

      return {
        window: { hours },
        summary: {
          vms: rows.length,
          running: rows.filter((r) => r.status === 'RUNNING').length,
          withIssues: rows.filter((r) => r.issues.length).length,
          unattachedDisks: unattachedDisks.length,
        },
        vms: rows,
        unattachedDisks,
        notes:
          'Patch status comes from OS Config vulnerability reports and agent health from OS Config inventory ' +
          'and Ops Agent metrics; VMs without those agents show them as missing.',
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
        ...projectNotes(config),
      };
    },
  };
}

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
    if (!d.snapshotSchedule && (d.snapshotAgeDays == null || d.snapshotAgeDays > 7))
      issues.push(
        `disk ${d.name}: no snapshot schedule and ${d.lastSnapshot ? `last snapshot ${d.snapshotAgeDays}d ago` : 'no snapshots'}`,
      );
  }
  if (running) {
    if (!inventory && !vmManagerOff) issues.push('OS Config agent not reporting (no patch or OS data)');
    else if (inventory && osAgeHours > 48) issues.push(`OS Config data is ${Math.round(osAgeHours)}h old`);
    if (!metrics?.opsAgent) issues.push('Ops Agent not reporting (no memory or disk metrics)');
  }
  if (counts.CRITICAL) issues.push(`${counts.CRITICAL} critical vulnerabilities (OS patches missing)`);
  if (counts.HIGH) issues.push(`${counts.HIGH} high vulnerabilities`);
  if (metrics?.diskPercent?.latest >= 85) issues.push(`disk ${metrics.diskPercent.latest}% full`);
  if (metrics?.memoryPercent?.avg >= 90) issues.push(`memory averaging ${metrics.memoryPercent.avg}%`);
  if (metrics?.cpuPercent?.avg >= 85) issues.push(`CPU averaging ${metrics.cpuPercent.avg}%`);

  const os = inventory?.osInfo;
  return {
    name: vm.name,
    projectId,
    zone: last(vm.zone),
    status: vm.status,
    machineType: last(vm.machineType),
    lastStart: vm.lastStartTimestamp ?? null,
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

function latestSnapshotByDisk(snapshots) {
  const out = new Map();
  for (const s of snapshots) {
    if (s.status !== 'READY' || !s.sourceDisk) continue;
    const prev = out.get(s.sourceDisk);
    if (!prev || s.creationTimestamp > prev) out.set(s.sourceDisk, s.creationTimestamp);
  }
  return out;
}

function vulnCounts(report) {
  const out = {};
  for (const v of report?.vulnerabilities ?? []) {
    const sev = v.details?.severity ?? 'UNKNOWN';
    out[sev] = (out[sev] ?? 0) + 1;
  }
  return out;
}

// OS Config names: projects/{p}/locations/{zone}/instances/{id or name}/inventory -> "zone/instance".
function instanceKey(name) {
  const m = name.match(/locations\/([^/]+)\/instances\/([^/]+)/);
  return m ? `${m[1]}/${m[2]}` : name;
}

const last = (url) => (url ? String(url).split('/').pop() : null);

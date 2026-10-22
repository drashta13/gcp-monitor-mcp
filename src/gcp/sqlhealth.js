import { projectNotes, perProject, mapLimit, metricsWithoutResource } from './util.js';
import { seg } from './rest.js';

const SQL = 'https://sqladmin.googleapis.com/v1';
const HOUR = 3600_000;

export const THRESHOLDS = {
  backupAgeHours: 36, // last successful backup older than this
  diskPercent: 85, // latest
  cpuPercent: 80, // average
  memoryPercent: 90, // average
};

// Cloud SQL health: configuration (HA, backups, PITR, maintenance) from the SQL Admin API, recent backup
// runs, and live metrics (uptime, CPU, memory, disk, connections, IOPS) from Cloud Monitoring.
// Needs cloudsql.instances.list and cloudsql.backupRuns.list (roles/cloudsql.viewer; roles/viewer has both).
export function createSqlHealthService({ scope, rest, usage, now = Date.now }) {
  async function forProject(projectId) {
    const { items } = await rest.list(`${SQL}/projects/${seg(projectId)}/instances`, { key: 'items' });
    return mapLimit(items, 4, async (inst) => {
      const backups = await rest
        .list(`${SQL}/projects/${seg(projectId)}/instances/${seg(inst.name)}/backupRuns`, {
          key: 'items',
          params: { maxResults: 20 },
          max: 20,
        })
        .then((r) => r.items)
        .catch((err) => ({ error: err.message }));
      return { projectId, inst, backups };
    }).then((settled) =>
      settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : { projectId, name: items[i]?.name, error: s.reason?.message ?? String(s.reason) },
      ),
    );
  }

  return {
    async health({ projectIds, names, hours = 24, endTime, limit = 100 }) {
      const ids = await scope(projectIds);
      const [config, metrics] = await Promise.all([
        perProject(ids, 4, forProject),
        usage.usage({ kind: 'cloudsql', projectIds: ids, hours, endTime, limit: Infinity }).catch((err) => ({ error: err.message })),
      ]);

      const metricsByName = new Map((metrics.resources ?? []).map((r) => [`${r.projectId}/${r.name}`, r.metrics]));
      const all = config.ok.flat();
      // An instance whose details couldn't be read is reported, not dropped.
      const instanceErrors = all.filter((x) => !x.inst).map(({ projectId, name, error }) => ({ projectId, name, error }));
      let instances = all.filter((x) => x.inst);
      // A past window (endTime): instances created after it are left out, and instances deleted since keep
      // their metrics under notFoundNow.
      const windowEndMs = endTime ? Date.parse(endTime) : null;
      const seen = new Set(all.map((x) => `${x.projectId}/${x.inst?.name ?? x.name}`));
      if (names?.length) instances = instances.filter((x) => names.includes(x.inst.name));
      if (windowEndMs) instances = instances.filter((x) => !(Date.parse(x.inst.createTime) >= windowEndMs));
      const notFoundNow = windowEndMs && !names?.length ? metricsWithoutResource(metricsByName, seen) : [];

      const rows = instances.map(({ projectId, inst, backups }) =>
        describe(projectId, inst, backups, metricsByName.get(`${projectId}/${inst.name}`), now()),
      );
      rows.sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));

      return {
        window: { hours, ...(endTime ? { end: endTime } : {}) },
        summary: {
          instances: rows.length,
          withIssues: rows.filter((r) => r.issues.length).length,
          highAvailability: rows.filter((r) => r.highAvailability).length,
        },
        returned: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        instances: rows.slice(0, limit),
        ...(notFoundNow.length ? { notFoundNow } : {}),
        ...(instanceErrors.length ? { instanceErrors } : {}),
        ...(metrics.error ? { metricsError: metrics.error } : {}),
        ...(metrics.metricErrors ? { metricErrors: metrics.metricErrors } : {}),
        ...projectNotes(config),
      };
    },
  };
}

export function describe(projectId, inst, backups, metrics, nowMs) {
  const s = inst.settings ?? {};
  const backup = s.backupConfiguration ?? {};
  const isReplica = inst.instanceType === 'READ_REPLICA_INSTANCE';
  const runs = Array.isArray(backups) ? backups : [];
  const lastSuccess = runs.find((b) => b.status === 'SUCCESSFUL');
  const failures = runs.filter((b) => b.status === 'FAILED');
  const lastSuccessAgeHours = lastSuccess
    ? (nowMs - Date.parse(lastSuccess.endTime ?? lastSuccess.startTime)) / HOUR
    : null;
  const pitr = Boolean(backup.pointInTimeRecoveryEnabled || backup.binaryLogEnabled);

  const issues = [];
  const stopped = s.activationPolicy === 'NEVER';
  if (inst.state !== 'RUNNABLE') issues.push(`state is ${inst.state}`);
  if (stopped) issues.push('stopped (activation policy NEVER)');
  if (!isReplica && s.availabilityType !== 'REGIONAL')
    issues.push('no high availability (zonal): no automatic failover');
  if (!isReplica && !backup.enabled) issues.push('automated backups are off');
  if (!isReplica && backup.enabled && !pitr) issues.push('point-in-time recovery is off');
  if (!isReplica && backup.enabled && lastSuccessAgeHours != null && lastSuccessAgeHours > THRESHOLDS.backupAgeHours)
    issues.push(`last successful backup was ${Math.round(lastSuccessAgeHours)}h ago`);
  if (!isReplica && backup.enabled && !lastSuccess && Array.isArray(backups))
    issues.push('no successful backup on record');
  if (failures.length) issues.push(`${failures.length} failed backup run(s) recently`);
  if (s.storageAutoResize === false) issues.push('storage auto-resize is off');
  if (!s.deletionProtectionEnabled) issues.push('deletion protection is off');
  if (metrics?.diskPercent?.latest >= THRESHOLDS.diskPercent) issues.push(`disk ${metrics.diskPercent.latest}% full`);
  if (metrics?.uptimePercent && metrics.uptimePercent.avg < 100)
    issues.push(`uptime ${metrics.uptimePercent.avg}% in window`);
  if (metrics?.cpuPercent?.avg >= THRESHOLDS.cpuPercent) issues.push(`CPU averaging ${metrics.cpuPercent.avg}%`);
  if (metrics?.memoryPercent?.avg >= THRESHOLDS.memoryPercent)
    issues.push(`memory averaging ${metrics.memoryPercent.avg}%`);
  if (inst.scheduledMaintenance?.startTime)
    issues.push(`maintenance scheduled for ${inst.scheduledMaintenance.startTime}`);

  return {
    name: inst.name,
    projectId,
    databaseVersion: inst.databaseVersion,
    tier: s.tier,
    region: inst.region,
    zone: inst.gceZone,
    state: inst.state,
    role: isReplica ? `read replica of ${inst.masterInstanceName}` : 'primary',
    highAvailability: s.availabilityType === 'REGIONAL',
    failover: {
      availabilityType: s.availabilityType ?? 'ZONAL',
      secondaryZone: inst.secondaryGceZone ?? null,
      replicas: inst.replicaNames ?? [],
    },
    backups: {
      enabled: Boolean(backup.enabled),
      pointInTimeRecovery: pitr,
      logRetentionDays: backup.transactionLogRetentionDays ?? null,
      retainedBackups: backup.backupRetentionSettings?.retainedBackups ?? null,
      startTime: backup.startTime ?? null,
      lastSuccessful: lastSuccess ? (lastSuccess.endTime ?? lastSuccess.startTime) : null,
      recentFailures: failures
        .slice(0, 3)
        .map((b) => ({ time: b.startTime, error: b.error?.message ?? b.error?.code })),
      ...(Array.isArray(backups) ? {} : { error: backups?.error }),
    },
    storage: { sizeGb: Number(s.dataDiskSizeGb) || null, autoResize: s.storageAutoResize !== false },
    maintenance: {
      window: s.maintenanceWindow?.day
        ? { day: s.maintenanceWindow.day, hourUtc: s.maintenanceWindow.hour ?? 0 }
        : 'any time',
      scheduled: inst.scheduledMaintenance?.startTime ?? null,
    },
    deletionProtection: Boolean(s.deletionProtectionEnabled),
    metrics: metrics ?? null,
    issues,
  };
}

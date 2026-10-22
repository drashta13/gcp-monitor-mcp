import { ConfigError } from '../gcp/errors.js';
import { addDays } from '../gcp/comparison.js';
import { KINDS } from '../gcp/inventory.js';
import { isManagedNodeName } from '../gcp/vmhealth.js';
import { PRESETS } from '../gcp/logs.js';
import { dateIn, dayWindow, mapLimit, round } from '../gcp/util.js';
import { fingerprint } from './store.js';

// Everything a snapshot can collect, cost sections first. All of them describe the same day: cost for
// that billing day, and metrics, incidents and logs for that day's 24 hours in the cost source's time zone.
export const SECTIONS = [
  'cost',
  'costSku',
  'costRegion',
  'costResources',
  'costComparison',
  'incidents',
  'cloudsql',
  'gke',
  'gkeWorkloads',
  'vm',
  'cloudrun',
  'logVolume',
  'logs',
  'inventory',
];

const COST_SECTIONS = new Set(['cost', 'costSku', 'costRegion', 'costResources', 'costComparison']);
const MAX_LISTED = 30;
const LOG_ENTRIES_PER_PRESET = 200;
const MAX_ANOMALY_FINDINGS = 100;
const MISSING_LOOKBACK_DAYS = 28; // how far back the daily run looks for gaps (older days: backfill with the CLI)
// Cloud Logging keeps most logs 30 days (the _Default bucket); admin-audit logs ("changes") 400 days. Past that,
// log samples and GKE event counts are incomplete, and must not read as "nothing happened".
const LOG_RETENTION_DAYS = 30;

// One daily snapshot: runs the same collectors every time, stores the raw results, and turns them into
// metrics (numbers to trend) and findings (issues to track across days). Calls the services directly,
// not through MCP, so a snapshot is identical whoever asks for it.
export function createCaptureService({
  billing,
  health = {},
  usage,
  inventory,
  store,
  costSource,
  retentionDays,
  now = () => new Date(),
}) {
  const timezone = billing.timezone ?? 'UTC';
  const source = costSource ?? (billing.note ? 'app-optimize' : 'bigquery-export');
  const service = (name) => {
    if (!health[name]) throw new ConfigError(`The ${name} health service is not configured on this server`);
    return health[name];
  };
  const need = (dep, name) => {
    if (!dep) throw new ConfigError(`The ${name} service is not configured on this server`);
    return dep;
  };

  async function runSection(section, { projectIds, day, window }) {
    const span = { projectIds, hours: window.hours, endTime: window.end };
    const oneDay = { startDate: day, endDate: day, projectIds };
    switch (section) {
      case 'cost': {
        const [byService, byProject, trend] = await Promise.all([
          billing.summary({ ...oneDay, groupBy: 'service', limit: 200 }),
          billing.summary({ ...oneDay, groupBy: 'project', limit: 200 }),
          // The week's daily totals, so days still filling in at the last capture get corrected.
          billing.trend({ startDate: addDays(day, -6), endDate: day, projectIds, granularity: 'day' }),
        ]);
        return { args: oneDay, result: { byService, byProject, trend } };
      }
      case 'costSku':
        return { args: oneDay, result: await billing.summary({ ...oneDay, groupBy: 'sku', limit: 300 }) };
      case 'costRegion':
        return { args: oneDay, result: await billing.summary({ ...oneDay, groupBy: 'region', limit: 100 }) };
      case 'costResources':
        return { args: oneDay, result: await billing.topResources({ ...oneDay, limit: 300 }) };
      case 'costComparison': {
        const args = { days: 7, baselineDays: 21, endDate: day, threshold: 25, limit: 50, projectIds };
        return { args, result: await billing.comparison(args) };
      }
      case 'incidents':
        return { args: span, result: await service('incidents').incidents(span) };
      case 'cloudsql':
      case 'vm': {
        const args = { ...span, limit: 1000 };
        return { args, result: await service(section).health(args) };
      }
      case 'gke':
        return { args: span, result: await service('gke').health(span) };
      case 'gkeWorkloads': {
        const args = { ...span, kind: 'gke', breakdown: 'namespace', limit: 2000 };
        return { args, result: await need(usage, 'usage').usage(args) };
      }
      case 'cloudrun':
      case 'logVolume': {
        const args = { ...span, kind: section === 'cloudrun' ? 'cloudrun' : 'logs', limit: 2000 };
        return { args, result: await need(usage, 'usage').usage(args) };
      }
      case 'logs': {
        const presets = Object.keys(PRESETS);
        const settled = await mapLimit(presets, 3, (preset) =>
          service('logs').query({ ...span, preset, limit: LOG_ENTRIES_PER_PRESET }),
        );
        if (settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
        const byPreset = Object.fromEntries(
          settled.map((s, i) => [presets[i], s.status === 'fulfilled' ? s.value : { error: s.reason?.message ?? String(s.reason) }]),
        );
        return { args: { ...span, presets, limit: LOG_ENTRIES_PER_PRESET }, result: { byPreset } };
      }
      case 'inventory': {
        const args = { projectIds, kinds: Object.keys(KINDS), includeInactive: true, limit: 10_000 };
        return { args, result: await need(inventory, 'inventory').list(args) };
      }
      default:
        throw new ConfigError(`Unknown section ${section}`);
    }
  }

  // Anomalies on a planned event's days are expected and don't become findings; a scale-up still there
  // after an event does, as "not scaled down".
  const anomaliesFor = (date) => {
    const found = store.anomalies({ date, limit: MAX_ANOMALY_FINDINGS });
    return { ...found, findings: dedupe(found.anomalies.filter((a) => !a.expected).map(anomalyFinding)) };
  };

  return {
    // Works out a stored day's anomaly findings again from the history (no Google Cloud calls): after the
    // detection rules change, or once older days were backfilled.
    recomputeAnomalies(day) {
      const snap = store.getSnapshot({ snapshotId: day });
      if (!snap) throw new ConfigError(`No snapshot for ${day}.`);
      const { findings, anomalies } = anomaliesFor(day);
      store.replaceAnomalyFindings(snap.snapshotId, findings);
      store.refreshSummary(snap.snapshotId);
      return { day, snapshotId: snap.snapshotId, anomalies: anomalies.length };
    },

    async capture({ projectIds, sections = SECTIONS, day } = {}) {
      // The history keeps account-wide totals per day; a capture of some projects would overwrite them.
      if (projectIds?.length) {
        throw new ConfigError('capture_snapshot always covers every configured project; use the live tools for a subset of projects.');
      }
      const today = dateIn(timezone, now());
      // Default: 2 days ago, the last complete day for both cost sources.
      const target = day ?? addDays(today, -2);
      if (target >= today) {
        throw new ConfigError(`day ${target} is not over yet in ${timezone} (today is ${today}); capture a past day.`);
      }
      const window = dayWindow(target, timezone);
      const wanted = SECTIONS.filter((s) => sections.includes(s));
      if (!wanted.length) throw new ConfigError(`No known section in ${JSON.stringify(sections)}. Sections: ${SECTIONS.join(', ')}.`);
      const ctx = { projectIds: undefined, day: target, window };

      // Cost sections one after another (each creates several cost reports); the rest a few at a time.
      const run = (s) => runSection(s, ctx).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
      const costPart = (async () => {
        const out = [];
        for (const s of wanted.filter((x) => COST_SECTIONS.has(x))) out.push(await run(s));
        return out;
      })();
      const otherSections = wanted.filter((x) => !COST_SECTIONS.has(x));
      const otherPart = mapLimit(otherSections, 4, (s) => run(s)).then((r) => r.map((x) => x.value));
      const [costResults, otherResults] = await Promise.all([costPart, otherPart]);
      const settled = [...costResults, ...otherResults];
      const order = [...wanted.filter((x) => COST_SECTIONS.has(x)), ...otherSections];

      const results = [];
      const errors = [];
      const skipped = [];
      const status = {};
      const logsExpired = Date.parse(window.start) < now().getTime() - LOG_RETENTION_DAYS * 86_400_000;
      settled.forEach((r, i) => {
        const section = order[i];
        if (r.status === 'fulfilled') {
          results.push({ section, ...r.value });
          // Some projects, metrics or presets failed: the data is incomplete, so absence proves nothing.
          const notes = sectionNotes(r.value.result);
          const expired = logsExpired && (section === 'logs' || section === 'gke');
          status[section] = notes || expired ? 'partial' : 'ok';
          if (notes) errors.push({ section, partial: true, ...notes });
          if (expired) {
            errors.push({
              section,
              partial: true,
              logRetention: `The day is older than Cloud Logging's usual ${LOG_RETENTION_DAYS}-day retention: ${
                section === 'logs' ? 'log samples are incomplete (admin-audit "changes" are kept 400 days)' : 'event and autoscaler counts are incomplete'
              }.`,
            });
          }
        } else if (r.reason instanceof ConfigError) {
          skipped.push({ section, reason: r.reason.message });
          status[section] = 'skipped';
        } else {
          errors.push({ section, error: r.reason?.message ?? String(r.reason) });
          status[section] = 'error';
        }
      });

      const metrics = results.flatMap((r) => extractMetrics(r.section, r.result, { date: target }));
      const findings = dedupe(results.flatMap((r) => extractFindings(r.section, r.result).map((f) => ({ ...f, section: r.section }))));
      const summary = { sections: status, cost: costHeadline(metrics, target) };

      const snapshotId = store.saveSnapshot({
        date: target,
        costDate: target,
        costSource: source,
        window,
        projects: 'all in scope',
        sections: order,
        errors: [...errors, ...skipped.map((s) => ({ ...s, skipped: true }))],
        summary,
        results,
        metrics,
        findings,
      });

      // Anomalies against the stored history of the days before, kept as findings of this snapshot.
      const anomalies = anomaliesFor(target);
      store.replaceAnomalyFindings(snapshotId, anomalies.findings);
      // Counts and statuses for the whole day, including sections kept from an earlier capture of it.
      const whole = store.refreshSummary(snapshotId);

      if (retentionDays) store.prune(retentionDays);

      const previous = store.previousSnapshotFindings(snapshotId);
      const diff = store.diffFindings(previous?.findings ?? [], store.snapshotFindings(snapshotId), whole.sections);
      const brief = (f) => ({ severity: f.severity, category: f.category, projectId: f.projectId, resource: f.resource, title: f.title });
      const missingDays = store.missingDays(addDays(today, -MISSING_LOOKBACK_DAYS), addDays(today, -2));

      return {
        snapshotId,
        day: target,
        window,
        costSource: source,
        sections: whole.sections,
        ...(wanted.length < SECTIONS.length ? { ranThisTime: order } : {}),
        cost: whole.cost && {
          ...whole.cost,
          basis: source === 'app-optimize' ? 'list price before credits' : 'net of credits',
          topServices: store
            .metricSeries({ metric: 'dailyCost', kind: 'cost_service', from: target, to: target, limit: 500 })
            .series.map((s) => ({ service: s.resource, cost: s.points[0].value }))
            .sort((a, b) => b.cost - a.cost)
            .slice(0, 5),
        },
        findings: whole.findings,
        anomalies: {
          found: anomalies.anomalies.length,
          top: anomalies.anomalies.slice(0, 10),
          ...(anomalies.anomalies.length === 0 && anomalies.notEnoughHistory ? { note: 'Not enough history yet for most series.' } : {}),
        },
        metricsRecorded: metrics.length,
        sinceLastSnapshot: previous
          ? {
              comparedWith: previous.date,
              new: diff.new.slice(0, MAX_LISTED).map(brief),
              resolved: diff.resolved.slice(0, MAX_LISTED).map(brief),
              ...(diff.notChecked.length ? { notChecked: diff.notChecked.slice(0, MAX_LISTED).map(brief) } : {}),
              persisting: diff.persisting.length,
              ...(diff.new.length > MAX_LISTED || diff.resolved.length > MAX_LISTED ? { truncated: true } : {}),
            }
          : 'first snapshot: nothing to compare with yet',
        ...(errors.length ? { errors } : {}),
        ...(skipped.length ? { skipped } : {}),
        ...(missingDays.length ? { missingDays } : {}),
        nextStep: missingDays.length
          ? `Capture the missing days too (capture_snapshot with day, oldest first): ${missingDays.join(', ')}.`
          : 'Done. Reports can read this day with get_history (snapshotId and section), find_anomalies and search_findings.',
      };
    },
  };
}

function costHeadline(metrics, day) {
  const total = metrics.find((m) => m.kind === 'cost_total' && m.metric === 'dailyCost' && m.date === day);
  return total ? { date: day, total: total.value, currency: total.unit } : null;
}

// ---- extraction (pure, exported for tests) ----

const UNIT = (key) => (/Percent/.test(key) ? '%' : /MiB$/.test(key) ? 'MiB' : /Ms$/.test(key) ? 'ms' : null);

// { cpuPercent: { avg, max, latest }, containerRestarts: { total } } -> one metric per statistic.
function statMetrics(metrics, base) {
  const out = [];
  for (const [key, v] of Object.entries(metrics ?? {})) {
    if (!v || typeof v !== 'object') continue;
    for (const stat of ['avg', 'max', 'latest', 'total']) {
      if (typeof v[stat] === 'number') out.push({ ...base, metric: `${key}.${stat}`, value: v[stat], unit: UNIT(key) });
    }
  }
  return out;
}

const costValue = (r) => r.netCost ?? r.cost;

// One metric per line; rows that share a key (a resource billed under two services) are added up, not
// overwritten by whichever comes last.
function costRows(rows, field, kind, date, withProject = false) {
  const out = new Map();
  for (const r of rows ?? []) {
    const projectId = withProject ? (r.projectId ?? r.project ?? '') : undefined;
    const resource = r[field] ?? '(none)';
    const key = JSON.stringify([projectId ?? '', resource, r.currency]);
    const prev = out.get(key);
    if (prev) prev.value = round(prev.value + (costValue(r) ?? 0));
    else out.set(key, { date, kind, resource, ...(withProject ? { projectId } : {}), metric: 'dailyCost', value: costValue(r), unit: r.currency });
  }
  return [...out.values()];
}

export function extractMetrics(section, result, { date }) {
  const out = [];
  switch (section) {
    case 'cost': {
      for (const [currency, t] of Object.entries(result.byService?.totals ?? {})) {
        // The BigQuery source totals netCost; App Optimize totals are { cost } per currency.
        const total = t?.netCost ?? t?.cost;
        if (total != null) out.push({ date, kind: 'cost_total', resource: 'total', metric: 'dailyCost', value: total, unit: currency });
      }
      out.push(...costRows(result.byService?.rows, 'service', 'cost_service', date));
      for (const r of result.byProject?.rows ?? []) {
        out.push({ date, projectId: r.project, kind: 'cost_project', resource: r.project, metric: 'dailyCost', value: costValue(r), unit: r.currency });
      }
      const seen = new Set(out.filter((m) => m.kind === 'cost_total').map((m) => m.date));
      for (const p of result.trend?.points ?? []) {
        if (seen.has(p.period)) continue;
        out.push({ date: p.period, kind: 'cost_total', resource: 'total', metric: 'dailyCost', value: costValue(p), unit: p.currency });
      }
      break;
    }
    case 'costSku':
      out.push(...costRows(result.rows, 'sku', 'cost_sku', date));
      break;
    case 'costRegion':
      out.push(...costRows(result.rows, 'region', 'cost_region', date));
      break;
    case 'costResources':
      out.push(...costRows(result.rows, 'resource', 'cost_resource', date, true));
      break;
    case 'costComparison':
      if (result.current?.perDay != null) {
        out.push({ date, kind: 'cost_total', resource: 'total', metric: 'weekPerDay', value: result.current.perDay, unit: result.currency });
        out.push({ date, kind: 'cost_total', resource: 'total', metric: 'baselinePerDay', value: result.baseline.perDay, unit: result.currency });
      }
      break;
    case 'incidents':
      out.push({ date, kind: 'incidents', resource: 'total', metric: 'alerts', value: result.summary?.incidents ?? 0 });
      out.push({ date, kind: 'incidents', resource: 'total', metric: 'open', value: result.summary?.open ?? 0 });
      for (const p of result.byPolicy ?? []) {
        out.push({ date, kind: 'incidents', resource: p.policy, metric: 'alerts', value: p.count });
        out.push({ date, kind: 'incidents', resource: p.policy, metric: 'minutes', value: p.totalMinutes });
      }
      if (Array.isArray(result.availability)) {
        for (const r of result.availability) out.push(...statMetrics(r.metrics, { date, projectId: r.projectId, kind: 'uptime', resource: r.name }));
      }
      break;
    case 'cloudsql':
    case 'gke':
    case 'vm': {
      const rows = result.instances ?? result.clusters ?? result.vms ?? [];
      // Resources that ran that day but are gone now still get their metrics (not Google-managed node VMs,
      // which GKE covers per cluster).
      const gone = (result.notFoundNow ?? []).filter((r) => section !== 'vm' || !isManagedNodeName(r.name));
      for (const r of [...rows, ...gone]) {
        out.push(...statMetrics(r.metrics, { date, projectId: r.projectId, kind: section, resource: r.name }));
      }
      out.push({ date, kind: section, resource: 'total', metric: 'withIssues', value: result.summary?.withIssues ?? 0 });
      if (section === 'vm') out.push({ date, kind: 'vm', resource: 'total', metric: 'unattachedDisks', value: result.unattachedDisks?.length ?? 0 });
      if (section === 'gke') {
        // Event and autoscaler counts per cluster (OOMKilling, BackOff, scaleUp...): restarts and scaling over time.
        for (const c of rows) {
          for (const [reason, n] of Object.entries(c.events ?? {})) {
            if (typeof n === 'number') out.push({ date, projectId: c.projectId, kind: 'gke', resource: c.name, metric: `events.${reason}`, value: n });
          }
          for (const [what, n] of Object.entries(c.autoscaling ?? {})) {
            if (typeof n === 'number') out.push({ date, projectId: c.projectId, kind: 'gke', resource: c.name, metric: `autoscaler.${what}`, value: n });
          }
        }
      }
      break;
    }
    case 'gkeWorkloads':
      for (const r of result.resources ?? []) {
        out.push(...statMetrics(r.metrics, { date, projectId: r.projectId, kind: 'gke_namespace', resource: `${r.name}/${r.namespace}` }));
      }
      break;
    case 'cloudrun':
      // The same service name often runs in several regions: keep them apart.
      for (const r of result.resources ?? []) {
        const resource = r.location ? `${r.name}@${r.location}` : r.name;
        out.push(...statMetrics(r.metrics, { date, projectId: r.projectId, kind: 'cloudrun', resource }));
      }
      break;
    case 'logVolume':
      for (const r of result.resources ?? []) {
        const n = r.metrics?.entries?.total;
        if (typeof n === 'number') out.push({ date, projectId: r.projectId, kind: 'logs', resource: `${r.name}/${r.severity}`, metric: 'entries.total', value: n });
      }
      break;
    case 'logs':
      for (const [preset, r] of Object.entries(result.byPreset ?? {})) {
        if (!r.error) out.push({ date, kind: 'log_preset', resource: preset, metric: 'entries', value: r.returned ?? 0 });
      }
      break;
    case 'inventory': {
      const counts = new Map();
      for (const r of result.resources ?? []) {
        const key = JSON.stringify([r.projectId, r.kind]);
        const c = counts.get(key) ?? counts.set(key, { projectId: r.projectId, kind: r.kind, active: 0, inactive: 0 }).get(key);
        c[r.active === false ? 'inactive' : 'active'] += 1;
      }
      for (const c of counts.values()) {
        out.push({ date, projectId: c.projectId, kind: 'inventory', resource: c.kind, metric: 'active', value: c.active });
        out.push({ date, projectId: c.projectId, kind: 'inventory', resource: c.kind, metric: 'inactive', value: c.inactive });
      }
      break;
    }
  }
  return out.filter((m) => Number.isFinite(m.value));
}

// Issue text -> severity. First match wins, so the specific low-severity cases come first.
const SEVERITY = [
  ['low', /^status (TERMINATED|STOPPED|SUSPENDED)$|stopped \(activation policy/],
  ['high', /^state is|^status |cluster status|cluster condition|node pool .* status|automated backups are off|no successful backup|failed backup|uptime|OOM|crash-loop|critical vulnerabilit|scheduling failure|blocked scale-up|node-not-ready/i],
  ['medium', /% full|CPU averaging|memory averaging|high vulnerabilit|last successful backup|point-in-time recovery is off|no high availability|container restarts|eviction|no snapshot schedule|control plane on|Ops Agent not reporting|OS Config|auto-repair off/i],
];
export const severityOf = (issue) => SEVERITY.find(([, re]) => re.test(issue))?.[0] ?? 'low';

export function extractFindings(section, result) {
  const out = [];
  switch (section) {
    case 'cloudsql':
    case 'gke':
    case 'vm': {
      const rows = result.instances ?? result.clusters ?? result.vms ?? [];
      for (const r of rows) {
        for (const issue of r.issues ?? []) {
          out.push({ category: section, severity: severityOf(issue), projectId: r.projectId, kind: section, resource: r.name, title: issue });
        }
      }
      for (const d of result.unattachedDisks ?? []) {
        out.push({
          category: 'vm',
          severity: 'low',
          projectId: d.projectId,
          kind: 'disk',
          resource: d.name,
          title: 'unattached disk (paying for storage nobody uses)',
          detail: `${d.sizeGb} GB in ${d.zone}`,
        });
      }
      break;
    }
    case 'incidents':
      for (const a of result.incidents ?? []) {
        // For a captured day: open at the end of the day, and the minutes inside it.
        const open = a.openAtWindowEnd ?? a.state === 'OPEN';
        const minutes = a.minutesInWindow ?? a.durationMinutes;
        out.push({
          category: 'incident',
          severity: open ? 'high' : 'medium',
          projectId: a.projectId,
          kind: a.resource?.type ?? 'alert',
          resource: a.resource?.name ?? '',
          title: `alert: ${a.policy}`,
          detail:
            `${open ? 'open at the end of the day' : 'closed'}; opened ${a.openTime}${a.closeTime ? `, closed ${a.closeTime}` : ''}` +
            `${minutes != null ? `; ${minutes} min that day` : ''}${a.metric ? `; ${a.metric}` : ''}`,
        });
      }
      for (const e of Array.isArray(result.googleCloudEvents) ? result.googleCloudEvents : []) {
        out.push({
          category: 'incident',
          severity: e.state === 'ACTIVE' ? 'high' : 'medium',
          projectId: e.projectId,
          kind: 'google-cloud',
          resource: (e.products ?? []).join(', '),
          title: `Google Cloud: ${e.title}`,
          detail: `${e.state}; ${e.startTime ?? `updated ${e.updateTime ?? 'n/a'}`}${e.endTime ? ` to ${e.endTime}` : ''}; ${(e.locations ?? []).join(', ')}`,
        });
      }
      for (const u of Array.isArray(result.availability) ? result.availability : []) {
        const avg = u.metrics?.availabilityPercent?.avg;
        if (avg != null && avg < 100) {
          out.push({
            category: 'incident',
            severity: avg < 99 ? 'high' : 'medium',
            projectId: u.projectId,
            kind: 'uptime',
            resource: u.name,
            title: 'uptime check below 100%',
            detail: `availability ${avg}% over the day`,
          });
        }
      }
      break;
    case 'costComparison':
      for (const a of result.anomalies ?? []) {
        out.push({
          category: 'cost',
          severity: a.type === 'spike' || a.type === 'increase' ? 'medium' : 'low',
          projectId: a.projectId ?? '',
          kind: a.scope,
          resource: a.name ?? '',
          title: `cost ${a.type}: ${a.scope === 'service' ? a.name : (a.service ?? a.scope)}`,
          detail: `${round(a.currentPerDay)}/day vs ${round(a.baselinePerDay)}/day baseline (${a.changePct ?? 'n/a'}%)`,
        });
      }
      break;
  }
  return out;
}

const KIND_CATEGORY = { gke_namespace: 'gke', uptime: 'incident', incidents: 'incident', log_preset: 'logs' };

// A statistical anomaly from the stored history -> a finding of the day's snapshot.
export function anomalyFinding(a) {
  const category = a.kind.startsWith('cost_') ? 'cost' : (KIND_CATEGORY[a.kind] ?? a.kind);
  if (a.notScaledDown) {
    const n = a.notScaledDown;
    return {
      category,
      severity: category === 'cost' ? 'high' : 'medium',
      projectId: a.projectId ?? '',
      kind: a.kind,
      resource: a.resource ?? '',
      // Stable title, so search_findings counts the days it stayed up.
      title: `not scaled down after ${n.kind}`,
      detail:
        `${a.metric} ${a.value}${a.unit ? ` ${a.unit}` : ''} vs ${a.baselineMean} on normal days and ${n.eventMean} during "${n.event}"; ` +
        `${n.daysAfterEnd} day(s) after it ended, about ${n.extraPerDay} a day above normal`,
      section: 'anomalies',
    };
  }
  const up = a.type === 'spike' || a.type === 'new';
  const detail =
    a.type === 'missing'
      ? `no data this day; reported on ${a.baselineDays} of the previous days`
      : a.type === 'new' || a.type === 'stopped'
        ? `${a.value}${a.unit ? ` ${a.unit}` : ''} this day vs ${a.baselineMean ?? 0} average before`
        : `${a.value} vs ${a.baselineMean} ± ${a.baselineSd} over ${a.baselineDays} days (${a.changePct ?? 'n/a'}%, z ${a.z})`;
  return {
    category,
    severity: up && (category === 'cost' || /error|ERROR|CRITICAL|restart|OOM|BackOff|alerts/i.test(`${a.metric} ${a.resource}`)) ? 'medium' : 'low',
    section: 'anomalies',
    projectId: a.projectId ?? '',
    kind: a.kind,
    resource: a.resource ?? '',
    title: `anomaly: ${a.metric === '*' ? 'stopped reporting' : `${a.metric} ${a.type}`}`,
    detail,
  };
}

// The same issue seen twice in one capture (e.g. two alerts from one policy) is one finding.
function dedupe(findings) {
  const out = new Map();
  for (const f of findings) {
    const key = fingerprint(f);
    const prev = out.get(key);
    if (!prev) out.set(key, { ...f, count: 1 });
    else {
      prev.count += 1;
      if (f.severity === 'high') prev.severity = 'high';
    }
  }
  return [...out.values()].map(({ count, ...f }) => (count > 1 ? { ...f, detail: `${f.detail ? `${f.detail}; ` : ''}seen ${count}x` } : f));
}

// Section-level problems worth keeping with the snapshot: failed projects, unreadable instances, metric errors.
function sectionNotes(result) {
  const notes = {};
  for (const k of ['failedProjects', 'instanceErrors', 'metricsError', 'metricErrors']) {
    if (result?.[k] && (!Array.isArray(result[k]) || result[k].length)) notes[k] = result[k];
  }
  // Failures nested in a section made of several calls (cost), or in an optional part (uptime).
  for (const sub of ['byService', 'byProject', 'trend']) {
    const failed = result?.[sub]?.failedProjects;
    if (failed?.length) notes.failedProjects = [...(notes.failedProjects ?? []), ...failed.map((f) => ({ ...f, in: sub }))];
  }
  if (result?.availability?.error) notes.availabilityError = result.availability.error;
  const presetErrors = Object.entries(result?.byPreset ?? {}).filter(([, r]) => r.error);
  if (presetErrors.length) notes.presetErrors = Object.fromEntries(presetErrors.map(([p, r]) => [p, r.error]));
  return Object.keys(notes).length ? notes : null;
}

import { fork } from 'node:child_process';
import { ConfigError } from '../gcp/errors.js';
import { checkStatement, runReadOnly, MAX_SQL_ROWS } from './sqlsafe.js';

const SQL_TIMEOUT_MS = 10_000;
const MAX_SECTION_CHARS = 100_000;

// How good a section's outcome is. Re-capturing a day replaces a section's earlier data only when the new
// outcome is at least as good, so a failed retry never wipes out a good earlier run.
const RANK = { ok: 3, partial: 2, skipped: 1, error: 0 };

// Which statistics anomalies are judged on: averages and totals. Max and latest of the same metric mostly move
// with the average and would triple every finding; the latest disk fill is the exception that matters.
const judged = (metric) => !/\.(max|latest)$/.test(metric) || metric === 'diskPercent.latest';

// Event counts that are simply absent on a quiet day: alerts per policy, log volume per resource type,
// GKE events and autoscaler decisions. Their baselines count a day the section ran fine as 0.
const sparse = (kind, metric) =>
  kind === 'logs' || kind === 'log_preset' || kind === 'incidents' || (kind === 'gke' && /^(events|autoscaler)\./.test(metric));

// Which capture section writes each metric kind. An anomaly check only calls a series "missing" when the
// day's snapshot ran that section successfully, so a failed section doesn't read as everything stopping.
export const KIND_SECTION = {
  cost_total: 'cost',
  cost_service: 'cost',
  cost_project: 'cost',
  cost_sku: 'costSku',
  cost_region: 'costRegion',
  cost_resource: 'costResources',
  incidents: 'incidents',
  uptime: 'incidents',
  cloudsql: 'cloudsql',
  gke: 'gke',
  gke_namespace: 'gkeWorkloads',
  vm: 'vm',
  cloudrun: 'cloudrun',
  logs: 'logVolume',
  log_preset: 'logs',
  inventory: 'inventory',
};

// Smallest change worth flagging, whatever the percentage: a VM going from 1% to 3% CPU is +200% and noise.
function noiseFloor(kind, metric, dailyCost) {
  if (kind.startsWith('cost_')) return Math.max(1, dailyCost * 0.005); // 0.5% of daily spend, at least 1 unit
  if (/Percent/.test(metric)) return 5; // percentage points
  if (/\.total$|^entries|^alerts$|^open$|^withIssues$|^unattachedDisks$|^active$|^inactive$/.test(metric)) return 3;
  // Units where a small absolute change means nothing, however large in %.
  if (/MiBps/.test(metric)) return 0.5; // network, MiB/s
  if (/Iops/.test(metric)) return 5;
  if (/^connections/.test(metric)) return 2;
  if (/^requestsPerSec/.test(metric)) return 1;
  if (/^latencyMs/.test(metric)) return 20;
  if (/^cpuCores/.test(metric)) return 0.1;
  if (/^memoryMiB/.test(metric)) return 128;
  if (/^(pods|nodes|instances)\./.test(metric)) return 1;
  if (/^minutes$/.test(metric)) return 5;
  return 0;
}

// Same issue, different day: numbers (percentages, counts, ages, timestamps) are replaced so
// "disk 91% full" and "disk 93% full" are one recurring finding.
export function fingerprint({ category, projectId, kind, resource, title }) {
  const text = String(title).toLowerCase().replace(/\d+(?:[.:-]\d+)*/g, '#').replace(/\s+/g, ' ').trim();
  return [category, projectId ?? '', kind ?? '', resource ?? '', text].join('|');
}

const json = (v) => JSON.stringify(v ?? null);
const parse = (s) => (s == null ? null : JSON.parse(s));

// History store over a node:sqlite database. With a file `path`, query_history_sql runs in a child process
// on its own read-only connection, and is killed after `sqlTimeoutMs`.
export function createHistoryStore(db, { path, now = () => new Date(), sqlTimeoutMs = SQL_TIMEOUT_MS } = {}) {
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const insertFinding = db.prepare(`
    INSERT INTO findings (snapshot_id, report_id, date, source, category, severity, project_id, kind, resource, title, detail, fingerprint, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upsertMetric = db.prepare(`
    INSERT INTO metrics (date, project_id, kind, resource, metric, value, unit, snapshot_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (date, project_id, kind, resource, metric)
    DO UPDATE SET value = excluded.value, unit = excluded.unit, snapshot_id = excluded.snapshot_id`);

  function addFindings(list, { snapshotId = null, reportId = null, date, source }) {
    for (const f of list) {
      insertFinding.run(
        snapshotId,
        reportId,
        f.date ?? date,
        source,
        f.category,
        f.severity,
        f.projectId ?? '',
        f.kind ?? '',
        f.resource ?? '',
        f.title,
        f.detail ?? null,
        fingerprint(f),
        f.section ?? null,
      );
    }
  }

  const findingRow = (r) => ({
    category: r.category,
    severity: r.severity,
    projectId: r.project_id || null,
    kind: r.kind || null,
    resource: r.resource || null,
    title: r.title,
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.section ? { section: r.section } : {}),
    fingerprint: r.fingerprint,
  });

  const snapshotFindings = (id) =>
    db
      .prepare('SELECT * FROM findings WHERE snapshot_id = ? ORDER BY severity, category, resource')
      .all(id)
      .map(findingRow);

  const snapshotHeader = (r) => ({
    snapshotId: r.id,
    capturedAt: r.captured_at,
    date: r.date,
    costDate: r.cost_date,
    costSource: r.cost_source,
    projects: parse(r.projects),
    sections: parse(r.sections),
    errors: parse(r.errors),
    summary: parse(r.summary),
    ...(r.window_start ? { window: { start: r.window_start, end: r.window_end } } : {}),
  });

  // A snapshot covers one day; "latest" is the most recent day captured, not the most recent capture
  // (a backfill writes old days after new ones).
  const LATEST = 'SELECT * FROM snapshots ORDER BY date DESC, id DESC LIMIT 1';
  const BEFORE = 'SELECT * FROM snapshots WHERE date < ? ORDER BY date DESC, id DESC LIMIT 1';

  // id, "latest", or a YYYY-MM-DD date.
  function resolveSnapshot(ref) {
    if (ref == null || ref === 'latest') return db.prepare(LATEST).get();
    if (typeof ref === 'number') return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(ref);
    return db.prepare('SELECT * FROM snapshots WHERE date = ? ORDER BY id DESC LIMIT 1').get(ref);
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  const bySeverity = (a, b) =>
    (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3) || a.fingerprint.localeCompare(b.fingerprint);

  // `laterSections` (section statuses of the later day): a finding that is gone only counts as resolved
  // when its section ran fine that day; otherwise nobody looked, and it is "notChecked".
  function diffFindings(before, after, laterSections) {
    const prev = new Map(before.map((f) => [f.fingerprint, f]));
    const next = new Map(after.map((f) => [f.fingerprint, f]));
    const checked = (f) => !laterSections || !f.section || f.section === 'anomalies' || laterSections[f.section] === 'ok';
    const gone = before.filter((f) => !next.has(f.fingerprint));
    return {
      new: after.filter((f) => !prev.has(f.fingerprint)).sort(bySeverity),
      resolved: gone.filter(checked).sort(bySeverity),
      notChecked: gone.filter((f) => !checked(f)).sort(bySeverity),
      persisting: after.filter((f) => prev.has(f.fingerprint)).sort(bySeverity),
    };
  }

  const allEvents = (kind) =>
    db
      .prepare(`SELECT * FROM events ${kind ? 'WHERE kind = ?' : ''} ORDER BY start_date, id`)
      .all(...(kind ? [kind] : []))
      .map(eventRow);

  // Cost of one event vs the normal days before it, per line, plus late scale-downs. A line counts as scaled up
  // when the event lifted it past the % threshold and the noise floor (the same test anomalies() uses); its
  // late days run from the end of the cooldown until it is back within half of the lift, up to the next
  // event, the latest day captured, or POST_EVENT_MAX_DAYS.
  function summarizeEvent(e, events, { baselineDays, limit, pctThreshold, upTo }) {
    const baseDays = normalDays(events, e.window.start, baselineDays);
    const baseSet = new Set(baseDays);
    const lastCaptured = upTo ?? db.prepare(LATEST).get()?.date ?? e.endDate;
    const next = events.find((x) => x.window.start > e.window.end);
    const postEnd = [shiftDay(e.endDate, POST_EVENT_MAX_DAYS), lastCaptured, next ? shiftDay(next.window.start, -1) : '9999-12-31'].sort()[0];
    const rows = db
      .prepare(
        `SELECT date, project_id, kind, resource, value, unit FROM metrics
         WHERE metric = 'dailyCost' AND kind IN ('cost_total', 'cost_service', 'cost_project', 'cost_resource') AND date >= ? AND date <= ?`,
      )
      .all(baseDays.at(-1) ?? e.window.start, postEnd > e.endDate ? postEnd : e.endDate);
    const lines = new Map();
    for (const r of rows) {
      const key = JSON.stringify([r.kind, r.project_id, r.resource]);
      const l = lines.get(key) ?? lines.set(key, { kind: r.kind, projectId: r.project_id || null, resource: r.resource, unit: r.unit, base: [], during: [], after: new Map() }).get(key);
      if (baseSet.has(r.date)) l.base.push(r.value);
      // Prep days count as part of the event: the scale-up is its cost.
      else if (r.date >= e.window.start && r.date <= e.endDate) l.during.push(r.value);
      else if (r.date > e.endDate) l.after.set(r.date, r.value);
    }
    const mean = (xs) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null);
    const total = [...lines.values()].find((l) => l.kind === 'cost_total');
    const dailyCost = mean(total?.base ?? []) ?? 0;
    const floor = Math.max(1, dailyCost * 0.005);
    const eventDays = daysBetween(e.window.start, e.endDate) + 1;
    const out = [];
    const late = [];
    for (const l of lines.values()) {
      const b = mean(l.base);
      const d = mean(l.during);
      if (b == null || d == null) continue;
      const extra = l.during.reduce((a, v) => a + (v - b), 0);
      const lift = d - b;
      const scaledUp = lift >= Math.max(floor, (Math.abs(b) * pctThreshold) / 100);
      let scaledDownOn = null;
      const lateDays = [];
      if (scaledUp) {
        // Scaled down: the first day after the event back within half of the lift.
        for (let i = 1; shiftDay(e.endDate, i) <= postEnd; i++) {
          const day = shiftDay(e.endDate, i);
          const v = l.after.get(day);
          if (v == null) continue;
          if (v - b <= Math.max(floor, lift / 2)) {
            scaledDownOn = day;
            break;
          }
          if (i > e.cooldownDays) lateDays.push({ day, value: r2(v), extra: r2(v - b) });
        }
      }
      const row = {
        kind: l.kind,
        ...(l.projectId ? { projectId: l.projectId } : {}),
        resource: l.resource,
        normalPerDay: r2(b),
        eventPerDay: r2(d),
        upPct: b ? r2((lift / Math.abs(b)) * 100) : null,
        extraDuringEvent: r2(extra),
        ...(scaledUp ? { scaledDownOn: scaledDownOn ?? `not by ${postEnd}`, daysToScaleDown: scaledDownOn ? daysBetween(e.endDate, scaledDownOn) : null } : {}),
        ...(l.unit ? { unit: l.unit } : {}),
      };
      if (l.kind !== 'cost_total') out.push(row);
      if (lateDays.length && l.kind !== 'cost_total') {
        late.push({ ...row, lateDays: lateDays.length, extraAfterCooldown: r2(lateDays.reduce((a, x) => a + x.extra, 0)), days: lateDays });
      }
    }
    const t = total && mean(total.base) != null && mean(total.during) != null ? total : null;
    return {
      event: e,
      baseline: { days: baseDays.length, from: baseDays.at(-1) ?? null, to: baseDays[0] ?? null },
      checkedUntil: postEnd,
      totals: t
        ? {
            normalPerDay: r2(mean(t.base)),
            eventCostPerDay: r2(mean(t.during)),
            eventCost: r2(t.during.reduce((a, v) => a + v, 0)),
            extraCost: r2(t.during.reduce((a, v) => a + (v - mean(t.base)), 0)),
            eventDays,
            daysCaptured: t.during.length,
            unit: t.unit,
          }
        : { note: 'No daily totals for the event or the days before it.' },
      scaledUpMost: out
        .filter((r) => (r.kind === 'cost_service' || r.kind === 'cost_resource') && r.scaledDownOn)
        .sort((a, b) => b.extraDuringEvent - a.extraDuringEvent)
        .slice(0, limit),
      notScaledDown: late
        .filter((r) => r.kind !== 'cost_project')
        .sort((a, b) => b.extraAfterCooldown - a.extraAfterCooldown)
        .slice(0, limit),
    };
  }

  return {
    // Saves a whole capture in one transaction: header, raw results, metrics, findings. One snapshot per day:
    // capturing a day again replaces the sections it ran and keeps the others from the earlier snapshot of
    // that day, so a failed section can be retried alone. Reports that cited the earlier snapshot follow.
    saveSnapshot({ date, costDate, costSource, window, projects, sections, errors, summary, results, metrics, findings }) {
      return tx(() => {
        const old = db.prepare('SELECT * FROM snapshots WHERE date = ? ORDER BY id').all(date);
        const prev = old.at(-1);
        const p = prev ? (parse(prev.summary) ?? {}) : {};
        const before = p.sections ?? {};
        const ran = new Set(sections.filter((s) => (RANK[summary.sections?.[s]] ?? -1) >= (RANK[before[s]] ?? -1)));
        const kept = (s) => s != null && !ran.has(s);
        let allSections = sections;
        let allErrors = errors;
        const merged = { ...summary, sections: { ...summary.sections } };
        if (prev) {
          for (const [s, st] of Object.entries(before)) if (kept(s)) merged.sections[s] = st;
          if (!ran.has('cost') && p.cost) merged.cost = p.cost;
          allSections = [...new Set([...(parse(prev.sections) ?? []), ...sections])];
          allErrors = [
            ...(parse(prev.errors) ?? []).filter((e) => kept(e.section)),
            ...errors.map((e) => (kept(e.section) ? { ...e, retryFailed: true, note: 'the earlier, better result of this section was kept' } : e)),
          ];
        }
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO snapshots (captured_at, date, cost_date, cost_source, projects, sections, errors, summary, window_start, window_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            now().toISOString(),
            date,
            costDate ?? null,
            costSource ?? null,
            json(projects),
            json(allSections),
            json(allErrors),
            json(merged),
            window?.start ?? null,
            window?.end ?? null,
          );
        const id = Number(lastInsertRowid);
        if (prev) {
          const others = [...ran];
          const notRan = others.length ? `AND section NOT IN (${others.map(() => '?').join(', ')})` : '';
          db.prepare(
            `INSERT INTO snapshot_results (snapshot_id, section, args_json, result_json)
             SELECT ?, section, args_json, result_json FROM snapshot_results WHERE snapshot_id = ? ${notRan}`,
          ).run(id, prev.id, ...others);
          // Findings of the kept sections move over; anomalies are worked out again for the whole day.
          db.prepare(
            `UPDATE findings SET snapshot_id = ? WHERE snapshot_id = ? AND section IS NOT NULL AND section <> 'anomalies' ${notRan}`,
          ).run(id, prev.id, ...others);
        }
        for (const o of old) {
          db.prepare('UPDATE reports SET snapshot_id = ? WHERE snapshot_id = ?').run(id, o.id);
          db.prepare('DELETE FROM snapshots WHERE id = ?').run(o.id);
        }
        const insertResult = db.prepare(
          'INSERT INTO snapshot_results (snapshot_id, section, args_json, result_json) VALUES (?, ?, ?, ?)',
        );
        for (const r of results) insertResult.run(id, r.section, json(r.args), json(r.result));
        for (const m of metrics) {
          upsertMetric.run(m.date, m.projectId ?? '', m.kind, m.resource ?? '', m.metric, m.value, m.unit ?? null, id);
        }
        addFindings(findings, { snapshotId: id, date, source: 'snapshot' });
        return id;
      });
    },

    // Sets a snapshot's anomaly findings (worked out from the stored history after the snapshot was saved).
    replaceAnomalyFindings(snapshotId, findings) {
      const s = db.prepare('SELECT date FROM snapshots WHERE id = ?').get(snapshotId);
      if (!s) throw new ConfigError(`No snapshot with id ${snapshotId}.`);
      tx(() => {
        db.prepare("DELETE FROM findings WHERE snapshot_id = ? AND section = 'anomalies'").run(snapshotId);
        addFindings(findings.map((f) => ({ ...f, section: 'anomalies' })), { snapshotId, date: s.date, source: 'snapshot' });
      });
    },

    // One-off clean-up: metrics of Google-managed node VMs (GKE "gke-"/"gk3-", VPC connector "aet-") that
    // older captures kept for nodes replaced since. Returns the number of rows removed.
    dropManagedNodeMetrics() {
      return Number(
        db
          .prepare("DELETE FROM metrics WHERE kind = 'vm' AND (resource LIKE 'gke-%' OR resource LIKE 'gk3-%' OR resource LIKE 'aet-%')")
          .run().changes,
      );
    },

    // Recounts a snapshot's findings by severity into its summary, and returns the summary.
    refreshSummary(snapshotId) {
      const s = db.prepare('SELECT summary FROM snapshots WHERE id = ?').get(snapshotId);
      if (!s) throw new ConfigError(`No snapshot with id ${snapshotId}.`);
      const summary = parse(s.summary) ?? {};
      summary.findings = { high: 0, medium: 0, low: 0 };
      for (const r of db.prepare('SELECT severity, COUNT(*) AS n FROM findings WHERE snapshot_id = ? GROUP BY severity').all(snapshotId)) {
        summary.findings[r.severity] = r.n;
      }
      db.prepare('UPDATE snapshots SET summary = ? WHERE id = ?').run(json(summary), snapshotId);
      return summary;
    },

    // Days in [from, to] with no usable snapshot, oldest first: never captured, nothing succeeded, or the cost
    // section failed (cost data is the part that expires first, so it is worth another try).
    missingDays(from, to) {
      const have = new Set();
      for (const r of db.prepare('SELECT date, summary FROM snapshots WHERE date >= ? AND date <= ?').all(from, to)) {
        const st = parse(r.summary)?.sections ?? {};
        const usable = Object.values(st).some((x) => x === 'ok' || x === 'partial') && st.cost !== 'error';
        if (usable) have.add(r.date);
      }
      const out = [];
      for (let d = from; d <= to; d = nextDay(d)) if (!have.has(d)) out.push(d);
      return out;
    },

    // New / resolved / persisting findings of a snapshot vs the snapshot before it (or `from`).
    diff({ from, to } = {}) {
      const after = resolveSnapshot(to);
      if (!after) {
        throw new ConfigError(to != null && to !== 'latest' ? `No snapshot found for "${to}".` : 'No snapshots yet: run capture_snapshot first.');
      }
      const before = from != null ? resolveSnapshot(from) : db.prepare(BEFORE).get(after.date);
      if (from != null && !before) throw new ConfigError(`No snapshot found for "${from}".`);
      const findings = diffFindings(before ? snapshotFindings(before.id) : [], snapshotFindings(after.id), parse(after.summary)?.sections);
      return {
        from: before ? { snapshotId: before.id, date: before.date } : null,
        to: { snapshotId: after.id, date: after.date },
        findings,
        metricChanges: before ? this.metricChanges(before, after) : [],
      };
    },

    // Health metrics (stored under the capture date) that moved by more than `minPct` between two snapshots.
    metricChanges(before, after, { minPct = 20, limit = 50 } = {}) {
      const rows = db
        .prepare(
          `SELECT a.project_id, a.kind, a.resource, a.metric, a.unit, b.value AS before, a.value AS after
           FROM metrics a JOIN metrics b
             ON a.project_id = b.project_id AND a.kind = b.kind AND a.resource = b.resource AND a.metric = b.metric
           WHERE a.date = ? AND b.date = ? AND a.date <> b.date`,
        )
        .all(after.date, before.date);
      return rows
        .map((r) => ({
          projectId: r.project_id || null,
          kind: r.kind,
          resource: r.resource || null,
          metric: r.metric,
          before: r.before,
          after: r.after,
          changePct: r.before ? Math.round(((r.after - r.before) / Math.abs(r.before)) * 1000) / 10 : null,
          ...(r.unit ? { unit: r.unit } : {}),
        }))
        .filter((r) => (r.changePct == null ? r.after !== r.before : Math.abs(r.changePct) >= minPct))
        .sort((a, b) => Math.abs(b.changePct ?? Infinity) - Math.abs(a.changePct ?? Infinity))
        .slice(0, limit);
    },

    saveReport({ date, kind, title, summary, bodyMarkdown, snapshotId, findings = [], tags = [] }) {
      return tx(() => {
        if (snapshotId != null && !db.prepare('SELECT 1 FROM snapshots WHERE id = ?').get(snapshotId)) {
          throw new ConfigError(`No snapshot with id ${snapshotId}.`);
        }
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO reports (created_at, date, kind, title, summary, body_markdown, snapshot_id, tags)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(now().toISOString(), date, kind, title, summary, bodyMarkdown, snapshotId ?? null, json(tags));
        const id = Number(lastInsertRowid);
        addFindings(findings, { reportId: id, date, source: 'report' });
        return id;
      });
    },

    list({ from, to, type = 'both', limit = 30 }) {
      const range = (col) => `(? IS NULL OR ${col} >= ?) AND (? IS NULL OR ${col} <= ?)`;
      const args = [from ?? null, from ?? null, to ?? null, to ?? null];
      const out = {};
      if (type !== 'snapshots') {
        out.reports = db
          .prepare(
            `SELECT r.id, r.date, r.kind, r.title, r.summary, r.snapshot_id, r.tags, r.created_at,
                    (SELECT COUNT(*) FROM findings f WHERE f.report_id = r.id) AS findings
             FROM reports r WHERE ${range('r.date')} ORDER BY r.date DESC, r.id DESC LIMIT ?`,
          )
          .all(...args, limit)
          .map((r) => ({
            reportId: r.id,
            date: r.date,
            kind: r.kind,
            title: r.title,
            summary: r.summary,
            snapshotId: r.snapshot_id,
            tags: parse(r.tags),
            findings: r.findings,
            createdAt: r.created_at,
          }));
      }
      if (type !== 'reports') {
        out.snapshots = db
          .prepare(`SELECT * FROM snapshots WHERE ${range('date')} ORDER BY date DESC, id DESC LIMIT ?`)
          .all(...args, limit)
          .map(snapshotHeader);
      }
      return out;
    },

    getReport({ reportId, date }) {
      const r =
        reportId != null
          ? db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId)
          : db.prepare('SELECT * FROM reports WHERE date = ? ORDER BY id DESC LIMIT 1').get(date);
      if (!r) return null;
      return {
        reportId: r.id,
        date: r.date,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        snapshotId: r.snapshot_id,
        tags: parse(r.tags),
        createdAt: r.created_at,
        bodyMarkdown: r.body_markdown,
        findings: db.prepare('SELECT * FROM findings WHERE report_id = ? ORDER BY id').all(r.id).map(findingRow),
      };
    },

    // A snapshot's header and findings, or one section's stored result. Section results are cut to `limit`
    // items per list and 1000 characters per string, so one call stays readable; `preset` picks one log preset.
    getSnapshot({ snapshotId, date, section, preset, limit = 50 }) {
      const s = resolveSnapshot(snapshotId ?? date);
      if (!s) return null;
      if (section) {
        const r = db
          .prepare('SELECT args_json, result_json FROM snapshot_results WHERE snapshot_id = ? AND section = ?')
          .get(s.id, section);
        let result = parse(r?.result_json);
        if (section === 'logs' && preset && result) result = { byPreset: { [preset]: result.byPreset?.[preset] ?? null } };
        const { value, cut } = trimResult(result, limit);
        const out = {
          snapshotId: s.id,
          date: s.date,
          section,
          status: parse(s.summary)?.sections?.[section] ?? 'not captured',
          args: parse(r?.args_json),
          result: value,
          ...(cut.length ? { cut: cut.slice(0, 20), note: 'Lists were cut to `limit` items; raise limit, or use query_history_sql with json_each.' } : {}),
        };
        const chars = JSON.stringify(out).length;
        if (chars > MAX_SECTION_CHARS) {
          return {
            ...out,
            result: null,
            tooLarge: { chars, max: MAX_SECTION_CHARS },
            note:
              'Too large to return at once. Pass a smaller limit' +
              (section === 'logs' ? ' or one preset' : '') +
              ', or query it with query_history_sql (json_extract / json_each on snapshot_results.result_json).',
          };
        }
        return out;
      }
      return { ...snapshotHeader(s), findings: snapshotFindings(s.id) };
    },

    // Findings of the snapshot for the day before this one's day (the nearest earlier day captured).
    previousSnapshotFindings(snapshotId) {
      const s = db.prepare('SELECT date FROM snapshots WHERE id = ?').get(snapshotId);
      const prev = s && db.prepare(BEFORE).get(s.date);
      return prev ? { date: prev.date, findings: snapshotFindings(prev.id) } : null;
    },

    diffFindings,
    snapshotFindings,

    // Findings matching the filters. groupBy "fingerprint" folds repeats into one row with first/last seen,
    // occurrences, and whether the latest snapshot still has it.
    searchFindings({ from, to, projectIds, resource, category, severity, source, text, groupBy = 'fingerprint', limit = 50 }) {
      const where = ['1 = 1'];
      const args = [];
      const add = (sql, ...v) => (where.push(sql), args.push(...v));
      if (from) add('f.date >= ?', from);
      if (to) add('f.date <= ?', to);
      if (projectIds?.length) add(`f.project_id IN (${projectIds.map(() => '?').join(', ')})`, ...projectIds);
      if (resource) add("f.resource LIKE ? ESCAPE '\\'", `%${likeEscape(resource)}%`);
      if (category) add('f.category = ?', category);
      if (severity?.length) add(`f.severity IN (${severity.map(() => '?').join(', ')})`, ...severity);
      if (source) add('f.source = ?', source);
      if (text) add("(f.title LIKE ? ESCAPE '\\' OR f.detail LIKE ? ESCAPE '\\')", `%${likeEscape(text)}%`, `%${likeEscape(text)}%`);
      const latest = db.prepare(LATEST).get();
      const openNow = new Set(latest ? snapshotFindings(latest.id).map((f) => f.fingerprint) : []);
      const latestSections = parse(latest?.summary)?.sections ?? {};
      // true: in the latest snapshot. false: its section ran fine there and the issue was gone. null: unknown,
      // because that section failed or didn't run on the latest day.
      const isOpen = (fp, section) =>
        openNow.has(fp) ? true : !section || section === 'anomalies' || latestSections[section] === 'ok' ? false : null;
      const rank = (v) => (v === true ? 2 : v === null ? 1 : 0);

      if (groupBy === 'none') {
        const rows = db
          .prepare(`SELECT f.* FROM findings f WHERE ${where.join(' AND ')} ORDER BY f.date DESC, f.id DESC LIMIT ?`)
          .all(...args, limit);
        return {
          latestSnapshotId: latest?.id ?? null,
          findings: rows.map((r) => ({
            date: r.date,
            source: r.source,
            ...(r.snapshot_id ? { snapshotId: r.snapshot_id } : {}),
            ...(r.report_id ? { reportId: r.report_id } : {}),
            ...findingRow(r),
          })),
        };
      }

      const rows = db
        .prepare(
          `SELECT f.fingerprint, MIN(f.date) AS first_seen, MAX(f.date) AS last_seen,
                  COUNT(DISTINCT f.date) AS days_seen, COUNT(*) AS occurrences, MAX(f.id) AS last_id
           FROM findings f WHERE ${where.join(' AND ')}
           GROUP BY f.fingerprint
           ORDER BY last_seen DESC, days_seen DESC LIMIT ?`,
        )
        .all(...args, limit);
      const latestRow = db.prepare('SELECT * FROM findings WHERE id = ?');
      return {
        latestSnapshotId: latest?.id ?? null,
        findings: rows
          .map((r) => {
            const last = latestRow.get(r.last_id);
            return {
              ...findingRow(last),
              firstSeen: r.first_seen,
              lastSeen: r.last_seen,
              daysSeen: r.days_seen,
              occurrences: r.occurrences,
              openNow: last.source === 'report' && !openNow.has(r.fingerprint) ? null : isOpen(r.fingerprint, last.section),
            };
          })
          .sort((a, b) => rank(b.openNow) - rank(a.openNow) || bySeverity(a, b)),
      };
    },

    // A metric's daily series per resource. Without `metric`, lists what has been recorded.
    metricSeries({ metric, kind, resource, projectIds, from, to, limit = 400 }) {
      const where = ['1 = 1'];
      const args = [];
      const add = (sql, ...v) => (where.push(sql), args.push(...v));
      if (kind) add('kind = ?', kind);
      if (resource) add("resource LIKE ? ESCAPE '\\'", `%${likeEscape(resource)}%`);
      if (projectIds?.length) add(`project_id IN (${projectIds.map(() => '?').join(', ')})`, ...projectIds);
      if (from) add('date >= ?', from);
      if (to) add('date <= ?', to);

      if (!metric) {
        const available = db
          .prepare(
            `SELECT kind, metric, COUNT(DISTINCT resource) AS resources, MIN(date) AS first_date, MAX(date) AS last_date
             FROM metrics WHERE ${where.join(' AND ')} GROUP BY kind, metric ORDER BY kind, metric`,
          )
          .all(...args)
          .map((r) => ({ kind: r.kind, metric: r.metric, resources: r.resources, from: r.first_date, to: r.last_date }));
        return { available };
      }

      add('metric = ?', metric);
      const rows = db
        .prepare(
          `SELECT date, project_id, kind, resource, value, unit FROM metrics WHERE ${where.join(' AND ')}
           ORDER BY kind, project_id, resource, date LIMIT ?`,
        )
        .all(...args, limit + 1);
      const series = new Map();
      for (const r of rows.slice(0, limit)) {
        const key = JSON.stringify([r.kind, r.project_id, r.resource]);
        const s =
          series.get(key) ??
          series
            .set(key, { kind: r.kind, projectId: r.project_id || null, resource: r.resource || null, unit: r.unit, points: [] })
            .get(key);
        s.points.push({ date: r.date, value: r.value });
      }
      return { metric, series: [...series.values()], ...(rows.length > limit ? { truncated: true } : {}) };
    },

    // ---- planned events (sales, migrations...) ----

    // Adds an event, or updates it when `id` is given. Dates are history days (the cost source's time zone).
    // On update, fields left out keep their stored values.
    saveEvent(input) {
      const { id } = input;
      const prev = id != null ? this.getEvent(id) : null;
      if (id != null && !prev) throw new ConfigError(`No event with id ${id}.`);
      const pick = (k, d) => (input[k] !== undefined ? input[k] : prev && prev[k] !== undefined ? prev[k] : d);
      const kind = pick('kind', 'sale');
      const name = pick('name');
      const startDate = pick('startDate');
      const endDate = pick('endDate');
      const prepDays = pick('prepDays', 0);
      const cooldownDays = pick('cooldownDays', 1);
      const notes = pick('notes', null);
      if (!name || !startDate || !endDate) throw new ConfigError('A new event needs name, startDate and endDate.');
      if (endDate < startDate) throw new ConfigError(`endDate ${endDate} is before startDate ${startDate}.`);
      const t = now().toISOString();
      if (id != null) {
        const r = db
          .prepare(
            `UPDATE events SET kind = ?, name = ?, start_date = ?, end_date = ?, prep_days = ?, cooldown_days = ?, notes = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(kind, name, startDate, endDate, prepDays, cooldownDays, notes ?? null, t, id);
        if (!r.changes) throw new ConfigError(`No event with id ${id}.`);
        return this.getEvent(id);
      }
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO events (kind, name, start_date, end_date, prep_days, cooldown_days, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, name, startDate, endDate, prepDays, cooldownDays, notes ?? null, t, t);
      return this.getEvent(Number(lastInsertRowid));
    },

    getEvent(id) {
      const r = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
      return r ? eventRow(r) : null;
    },

    // Events whose window (prep .. cooldown) overlaps [from, to], oldest first.
    listEvents({ from, to, kind } = {}) {
      return allEvents(kind).filter((e) => (!to || e.window.start <= to) && (!from || e.window.end >= from));
    },

    deleteEvent(id) {
      const e = this.getEvent(id);
      if (!e) throw new ConfigError(`No event with id ${id}.`);
      db.prepare('DELETE FROM events WHERE id = ?').run(id);
      return e;
    },

    // Statistical anomalies on `date` (default: the latest day captured) against the `baselineDays` normal days
    // before it, for every stored series: spikes and drops (|z| and % change past the thresholds, and above a
    // noise floor), cost lines that are new or stopped, and resources that stopped reporting although their
    // section ran fine. Sparse event counts (alerts, log volume, GKE events) count quiet days as 0. Days inside
    // a planned event's window (prep .. cooldown) are left out of baselines; anomalies on such a day are marked
    // expected, and a spike in the two weeks after an event that is still near event level is marked
    // notScaledDown.
    anomalies({ date, kinds, projectIds, baselineDays = 14, minPoints = 5, zThreshold = 3, pctThreshold = 25, limit = 50 } = {}) {
      const snap =
        date != null
          ? db.prepare('SELECT date, summary FROM snapshots WHERE date = ? ORDER BY id DESC LIMIT 1').get(date)
          : db.prepare(LATEST).get();
      if (!snap) {
        throw new ConfigError(
          date != null
            ? `No snapshot for ${date}: that day was not captured (capture_snapshot {"day": "${date}"}; list_history shows what exists).`
            : 'No snapshots yet: run capture_snapshot first.',
        );
      }
      const day = snap.date;
      const sectionsOnDay = parse(snap.summary)?.sections ?? {};
      const sectionRan = (kind) => sectionsOnDay[KIND_SECTION[kind]] === 'ok';

      // Planned events: the day's own phase, the latest event that ended before it, and the days to keep out
      // of baselines: the event window, and the two weeks after it, when a late scale-down would otherwise
      // become the new "normal".
      const events = allEvents();
      const onEvent = eventPhase(events, day);
      // The latest event that ended before the day, if recent enough to still be scaled up; its own normal
      // days before it are the reference for "back to normal".
      const after = events.filter((e) => e.window.end < day && daysBetween(e.endDate, day) <= POST_EVENT_MAX_DAYS).at(-1);
      const preDays = after ? normalDays(events, after.window.start, baselineDays) : [];
      const preSet = new Set(preDays);

      // The `baselineDays` most recent normal days before `day`.
      const baseDays = normalDays(events, day, baselineDays);
      const skipped = baseDays.length ? daysBetween(baseDays.at(-1), day) - baseDays.length : 0; // event days passed over
      const baseSet = new Set(baseDays);
      const from = baseDays.at(-1) ?? shiftDay(day, -1);
      const to = baseDays[0] ?? shiftDay(day, -1);

      // Baseline days on which each section ran fine (for zero-filling sparse counts).
      const okDays = new Map();
      for (const r of db.prepare('SELECT date, summary FROM snapshots WHERE date >= ? AND date <= ?').all(from, to)) {
        if (!baseSet.has(r.date)) continue;
        for (const [sec, st] of Object.entries(parse(r.summary)?.sections ?? {})) {
          if (st === 'ok') (okDays.get(sec) ?? okDays.set(sec, new Set()).get(sec)).add(r.date);
        }
      }
      // The account's mean daily spend on normal days sets the cost noise floor, whatever the filters.
      const costDays = db
        .prepare("SELECT date, value FROM metrics WHERE kind = 'cost_total' AND metric = 'dailyCost' AND project_id = '' AND date >= ? AND date <= ?")
        .all(from, to)
        .filter((r) => baseSet.has(r.date));
      const dailyCost = costDays.length ? costDays.reduce((a, r) => a + r.value, 0) / costDays.length : 0;

      const where = ['date >= ?', 'date <= ?'];
      const args = [[from, ...(after ? [after.window.start, preDays.at(-1) ?? after.window.start] : [])].sort()[0], day];
      if (kinds?.length) where.push(`kind IN (${kinds.map(() => '?').join(', ')})`), args.push(...kinds);
      if (projectIds?.length) where.push(`project_id IN (${projectIds.map(() => '?').join(', ')})`), args.push(...projectIds);
      const rows = db
        .prepare(`SELECT date, project_id, kind, resource, metric, value, unit FROM metrics WHERE ${where.join(' AND ')}`)
        .all(...args);

      const series = new Map();
      const daysByKind = new Map(); // baseline days on which each kind + metric has any data
      for (const r of rows) {
        if (!judged(r.metric)) continue;
        const key = JSON.stringify([r.kind, r.project_id, r.resource, r.metric]);
        const s =
          series.get(key) ??
          series
            .set(key, {
              kind: r.kind,
              projectId: r.project_id,
              resource: r.resource,
              metric: r.metric,
              unit: r.unit,
              byDay: new Map(),
              aroundEvent: new Map(), // values on the latest event's days and the normal days before it
              current: null,
            })
            .get(key);
        if (r.date === day) s.current = r.value;
        else if (baseSet.has(r.date)) {
          s.byDay.set(r.date, r.value);
          const km = `${r.kind}|${r.metric}`;
          (daysByKind.get(km) ?? daysByKind.set(km, new Set()).get(km)).add(r.date);
        }
        if (after && ((r.date >= after.window.start && r.date < day) || preSet.has(r.date))) s.aroundEvent.set(r.date, r.value);
      }
      // Which sections ran fine on the latest event's days and the days before it (sparse counts are 0 there).
      const eventDates = after ? Array.from({ length: daysBetween(after.window.start, after.endDate) + 1 }, (_, i) => shiftDay(after.window.start, i)) : [];
      const ranOn = new Map();
      if (after) {
        for (const r of db.prepare('SELECT date, summary FROM snapshots WHERE date >= ? AND date < ?').all(preDays.at(-1) ?? after.window.start, day)) {
          ranOn.set(r.date, parse(r.summary)?.sections ?? {});
        }
      }
      const postDates = after ? Array.from({ length: Math.max(0, daysBetween(after.endDate, day) - 1) }, (_, i) => shiftDay(after.endDate, i + 1)) : [];
      const valuesOn = (s, dates, isSparse) =>
        isSparse
          ? dates.filter((d) => ranOn.get(d)?.[KIND_SECTION[s.kind]] === 'ok').map((d) => s.aroundEvent.get(d) ?? 0)
          : dates.filter((d) => s.aroundEvent.has(d)).map((d) => s.aroundEvent.get(d));

      const out = [];
      const missingResources = new Set();
      let insufficient = 0;
      const avg = (xs) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null);
      for (const s of series.values()) {
        const isSparse = sparse(s.kind, s.metric);
        const floor = noiseFloor(s.kind, s.metric, dailyCost);
        // Did the latest event scale this series up? Then days after it that are still at least halfway up are
        // not "normal" days, however long ago the event was: a scale-up left in place never becomes the norm.
        const preValues = after ? valuesOn(s, preDays, isSparse) : [];
        const preMean = avg(preValues);
        const eventValues = after ? valuesOn(s, eventDates, isSparse) : [];
        const eventMean = avg(eventValues);
        const eventPeak = eventValues.length ? Math.max(...eventValues) : null;
        const lift = preMean != null && eventMean != null ? eventMean - preMean : 0;
        const liftedByEvent = after && lift >= Math.max(floor, (Math.abs(preMean ?? 0) * pctThreshold) / 100);
        const stillUp = (v) => liftedByEvent && v >= preMean + lift / 2;
        const usable = (d) => !(d > after?.window.end && stillUp(s.byDay.get(d) ?? -Infinity));
        let baseline = [...s.byDay].filter(([d]) => usable(d)).map(([, v]) => v);
        if (isSparse) {
          baseline = [...(okDays.get(KIND_SECTION[s.kind]) ?? [])].filter(usable).map((d) => s.byDay.get(d) ?? 0);
          if (s.current == null && sectionRan(s.kind)) s.current = 0;
        }
        // Up since the event for every recent day: compare with the normal days before the event instead.
        if (liftedByEvent && baseline.length < minPoints && preValues.length >= minPoints) baseline = preValues;
        const n = baseline.length;
        const base = { kind: s.kind, projectId: s.projectId || null, resource: s.resource || null, metric: s.metric, ...(s.unit ? { unit: s.unit } : {}) };
        if (s.current != null && n >= minPoints) {
          const mean = baseline.reduce((a, v) => a + v, 0) / n;
          const sd = Math.sqrt(baseline.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
          const delta = s.current - mean;
          const pct = mean !== 0 ? (delta / Math.abs(mean)) * 100 : null;
          const z = sd > 0 ? delta / sd : delta === 0 ? 0 : Math.sign(delta) * Infinity;
          if (Math.abs(delta) >= floor && delta !== 0 && (pct == null || Math.abs(pct) >= pctThreshold) && Math.abs(z) >= zThreshold) {
            // After an event: the event really scaled this series up (past the % threshold and the noise floor),
            // and the day is still at that level: at least halfway up from before the event, and not above what
            // the event itself reached (its peak, with a quarter more, or twice the average lift). Far above the
            // event level is a new problem, not a scale-up left in place.
            const ceiling = preMean + Math.max(lift * 2, (eventPeak - preMean) * 1.25);
            // ...and it never came back down since the event: every day in between (with data) still up.
            const neverDown = () => valuesOn(s, postDates, isSparse).every((v) => stillUp(v));
            const lingering = liftedByEvent && delta > 0 && stillUp(s.current) && s.current <= ceiling && neverDown();
            out.push({
              ...base,
              // A count that was zero every day of the baseline and isn't now: something new started.
              type: mean === 0 && sd === 0 ? 'new' : delta > 0 ? 'spike' : 'drop',
              value: r2(s.current),
              baselineMean: r2(mean),
              baselineSd: r2(sd),
              baselineDays: n,
              changePct: pct == null ? null : r2(pct),
              z: Number.isFinite(z) ? r2(z) : z > 0 ? 'inf' : '-inf',
              ...(lingering
                ? {
                    notScaledDown: {
                      event: after.name,
                      eventId: after.id,
                      kind: after.kind,
                      daysAfterEnd: daysBetween(after.endDate, day),
                      normalBefore: r2(preMean),
                      eventMean: r2(eventMean),
                      extraPerDay: r2(s.current - preMean),
                    },
                  }
                : {}),
              score: Math.min(Math.abs(z), 100) + (lingering ? 100 : 0),
            });
          }
        } else if (s.current != null && n === 0 && !isSparse) {
          // A cost line with no baseline at all, where that kind of line has enough history: new spend.
          if (s.metric === 'dailyCost' && s.kind !== 'cost_total' && (daysByKind.get(`${s.kind}|${s.metric}`)?.size ?? 0) >= minPoints && s.current >= floor) {
            out.push({ ...base, type: 'new', value: r2(s.current), baselineDays: 0, score: 50 });
          } else insufficient += 1;
        } else if (s.current == null && n >= minPoints && sectionRan(s.kind)) {
          const mean = baseline.reduce((a, v) => a + v, 0) / n;
          if (s.kind.startsWith('cost_')) {
            if (mean >= floor) out.push({ ...base, type: 'stopped', value: 0, baselineMean: r2(mean), baselineDays: n, score: 50 });
          } else if (s.resource && s.resource !== 'total') {
            // A resource that stopped reporting every metric: one row per resource, not per metric.
            const rk = JSON.stringify([s.kind, s.projectId, s.resource]);
            if (!missingResources.has(rk)) {
              missingResources.add(rk);
              out.push({ ...base, metric: '*', type: 'missing', baselineDays: n, score: 40 });
            }
          }
        } else if (s.current != null) insufficient += 1;
      }
      // Drop "missing" rows for resources that still report some metric that day.
      const reporting = new Set(
        [...series.values()].filter((s) => s.current != null).map((s) => JSON.stringify([s.kind, s.projectId, s.resource])),
      );
      const expected = onEvent ? { event: onEvent.event.name, eventId: onEvent.event.id, kind: onEvent.event.kind, phase: onEvent.phase } : null;
      const anomalies = out
        .filter((a) => a.type !== 'missing' || !reporting.has(JSON.stringify([a.kind, a.projectId ?? '', a.resource ?? ''])))
        .sort((a, b) => b.score - a.score || gap(b) - gap(a))
        .map(({ score, ...a }) => (expected && explainedByEvent(a) ? { ...a, expected } : a));

      return {
        date: day,
        baseline: { from, to, days: baseDays.length, ...(skipped ? { eventDaysSkipped: skipped } : {}) }, // event + 2 weeks after
        ...(expected ? { onEvent: expected, note: `${day} is in the ${expected.phase} window of "${expected.event}": changes are expected.` } : {}),
        ...(after ? { afterEvent: { event: after.name, eventId: after.id, kind: after.kind, endDate: after.endDate, daysAfterEnd: daysBetween(after.endDate, day) } } : {}),
        sections: sectionsOnDay,
        thresholds: {
          zThreshold,
          pctThreshold,
          minPoints,
          noiseFloor: `cost: max(1, 0.5% of mean daily spend = ${r2(Math.max(1, dailyCost * 0.005))}); percentages: 5 points; counts: 3`,
        },
        seriesChecked: series.size,
        notEnoughHistory: insufficient,
        returned: Math.min(anomalies.length, limit),
        truncated: anomalies.length > limit,
        anomalies: anomalies.slice(0, limit),
      };
    },

    // How a planned event went, from the cost history: spend during it vs normal days before it, the services and
    // resources that scaled up most, whether each one came back to normal within the cooldown (and what the days
    // it didn't cost), and the same numbers for the previous event of the same kind.
    reviewEvent({ id, date, baselineDays = 14, pctThreshold = 25, limit = 15 } = {}) {
      const events = allEvents();
      // Default: the latest event that has started by the latest day captured (not an upcoming one).
      const until = date ?? db.prepare(LATEST).get()?.date ?? now().toISOString().slice(0, 10);
      const e = id != null ? events.find((x) => x.id === id) : events.filter((x) => x.window.start <= until).at(-1);
      if (!e) {
        if (id != null) throw new ConfigError(`No event with id ${id}.`);
        if (!events.length) throw new ConfigError('No events recorded yet: add one with add_event.');
        const next = events.find((x) => x.window.start > until);
        throw new ConfigError(`No event started on or before ${until}; the next one is "${next.name}" from ${next.startDate} (list_events shows them all).`);
      }
      const prev = events.filter((x) => x.kind === e.kind && x.endDate < e.window.start).at(-1);
      const review = (ev) => summarizeEvent(ev, events, { baselineDays, limit, pctThreshold });
      const current = review(e);
      const previous = prev ? review(prev) : null;
      const change = (a, b) => (a != null && b ? r2(((a - b) / Math.abs(b)) * 100) : null);
      return {
        ...current,
        ...(previous
          ? {
              previous: { event: previous.event, totals: previous.totals, notScaledDown: previous.notScaledDown.slice(0, 5) },
              vsPrevious: {
                eventCostPerDayChangePct: change(current.totals.eventCostPerDay, previous.totals.eventCostPerDay),
                extraCostChangePct: change(current.totals.extraCost, previous.totals.extraCost),
              },
            }
          : {}),
      };
    },

    // Read-only SQL for open questions: one SELECT/WITH statement, SQLite's authorizer refusing anything but
    // reads. On a file database it runs in a child process that is killed after `sqlTimeoutMs`.
    async sql({ sql, limit = 100 }) {
      const text = checkStatement(sql);
      const cap = Math.min(limit, MAX_SQL_ROWS);
      if (!path || path === ':memory:') return runReadOnly(db, text, cap);
      return new Promise((resolve, reject) => {
        const child = fork(new URL('./sql-runner.js', import.meta.url), [], {
          execArgv: ['--max-old-space-size=256'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let done = false;
        const finish = (fn) => (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(reject)(
            new ConfigError(
              `The query ran longer than ${sqlTimeoutMs / 1000}s and was stopped. Narrow it (date range, LIMIT, a stop condition on recursive CTEs).`,
            ),
          );
        }, sqlTimeoutMs);
        child.on('message', (m) => finish(m.ok ? resolve : reject)(m.ok ? m.result : m.config ? new ConfigError(m.error) : new Error(m.error)));
        child.on('error', (err) => finish(reject)(err));
        child.on('exit', (code, signal) => finish(reject)(new Error(`The query process ended without an answer (${signal ?? `exit ${code}`}).`)));
        child.send({ path, text, limit: cap });
      });
    },

    // Drops snapshots, reports and metrics older than `days`.
    prune(days) {
      const cutoff = new Date(now().getTime() - days * 86_400_000).toISOString().slice(0, 10);
      return tx(() => ({
        snapshots: Number(db.prepare('DELETE FROM snapshots WHERE date < ?').run(cutoff).changes),
        reports: Number(db.prepare('DELETE FROM reports WHERE date < ?').run(cutoff).changes),
        metrics: Number(db.prepare('DELETE FROM metrics WHERE date < ?').run(cutoff).changes),
      }));
    },

    close() {
      db.close();
    },
  };
}

const r2 = (n) => Math.round(n * 100) / 100;
const POST_EVENT_DAYS = 14; // days after an event (and its cooldown) kept out of every baseline
const POST_EVENT_MAX_DAYS = 60; // how long after an event a scale-up still at event level is put down to it

// The `count` most recent normal days before `before`: not in any event's window or the POST_EVENT_DAYS after
// it. Looks back up to three times as far, plus the event days it skips.
function normalDays(events, before, count) {
  const out = [];
  let skipped = 0;
  for (let i = 1; out.length < count && i <= count * 3 + skipped; i++) {
    const d = shiftDay(before, -i);
    if (events.some((e) => d >= e.window.start && d <= shiftDay(e.window.end, POST_EVENT_DAYS))) skipped += 1;
    else out.push(d);
  }
  return out;
}

// What a sale explains: more load, capacity and spend. Not drops, resources that stopped reporting, stopped
// cost lines, or errors, alerts, restarts and failures, which are still problems on a sale day.
function explainedByEvent(a) {
  if (a.type !== 'spike' && a.type !== 'new') return false;
  if (a.kind === 'incidents' || a.kind === 'uptime' || a.kind === 'log_preset') return false;
  return !/ERROR|CRITICAL|ALERT|EMERGENCY|restart|OOM|BackOff|Failed|Unhealthy|Evicted|Killing|NotReady|Blocked/i.test(`${a.metric} ${a.resource ?? ''}`);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function eventRow(r) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    prepDays: r.prep_days,
    cooldownDays: r.cooldown_days,
    ...(r.notes ? { notes: r.notes } : {}),
    window: { start: shiftDay(r.start_date, -r.prep_days), end: shiftDay(r.end_date, r.cooldown_days) },
  };
}

// Where `day` falls in an event's window: prep (before the start), during, or cooldown (after the end).
function eventPhase(events, day) {
  const e = events.find((x) => day >= x.window.start && day <= x.window.end);
  if (!e) return null;
  return { event: e, phase: day < e.startDate ? 'prep' : day <= e.endDate ? 'during' : 'cooldown' };
}
const gap = (a) => Math.abs((a.value ?? 0) - (a.baselineMean ?? 0));
const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Cuts every list to `limit` items and long strings to 1000 characters; reports where lists were cut.
function trimResult(value, limit) {
  const cut = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      if (v.length > limit) cut.push({ path: path || '(root)', total: v.length, returned: limit });
      return v.slice(0, limit).map((x, i) => walk(x, `${path}[${i}]`));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)]));
    if (typeof v === 'string' && v.length > 1000) return `${v.slice(0, 1000)}… (${v.length} chars)`;
    return v;
  };
  return { value: walk(value, ''), cut };
}

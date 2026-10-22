#!/usr/bin/env node
// Captures history snapshots without Claude: for backfilling past days, or for a cron / launchd job.
//
//   node src/capture-cli.js                         the default day (2 days ago in the cost source's time zone)
//   node src/capture-cli.js --day 2026-10-01
//   node src/capture-cli.js --from 2026-09-18 --to 2026-10-13 [--skip-existing]
//   node src/capture-cli.js --missing               every recent day without a snapshot (last 28 days)
//   node src/capture-cli.js --recompute-anomalies   no Google Cloud calls: work out every stored day's anomaly
//                                                   findings again (oldest first) after the rules changed
//
// Reads the same environment variables as the MCP server. Progress goes to stderr, one JSON line per day
// to stdout. Exits 1 if any day failed or has a section in error (for cron / launchd alerts).
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createServices } from './services.js';
import { addDays } from './gcp/comparison.js';
import { dateIn } from './gcp/util.js';
import { SECTIONS } from './history/capture.js';

const { values: opts } = parseArgs({
  options: {
    day: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    missing: { type: 'boolean', default: false },
    'skip-existing': { type: 'boolean', default: false },
    'recompute-anomalies': { type: 'boolean', default: false },
    sections: { type: 'string' },
  },
});

const config = loadConfig();
if (!config.historyEnabled) {
  console.error('History is off (GCP_MONITOR_HISTORY). Nothing to capture into.');
  process.exit(2);
}
const { history, billing } = createServices(config);
const today = dateIn(billing.timezone ?? 'UTC');

if (opts['recompute-anomalies']) {
  const dropped = history.store.dropManagedNodeMetrics();
  if (dropped) console.error(`[recompute] removed ${dropped} metrics of Google-managed node VMs`);
  const stored = history.store.list({ type: 'snapshots', limit: 100_000 }).snapshots.map((s) => s.date).sort();
  const inRange = stored.filter((d) => (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to));
  for (const day of inRange) {
    const out = history.capture.recomputeAnomalies(day);
    console.error(`[recompute] ${day}: ${out.anomalies} anomalies`);
    console.log(JSON.stringify(out));
  }
  history.store.close();
  process.exit(0);
}
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');

let days;
if (opts.missing) days = history.store.missingDays(addDays(today, -28), addDays(today, -2));
else if (opts.from || opts.to) {
  if (!isDay(opts.from) || !isDay(opts.to) || opts.from > opts.to) {
    console.error('--from and --to must be YYYY-MM-DD, from <= to');
    process.exit(2);
  }
  days = [];
  for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) days.push(d);
} else if (opts.day) {
  if (!isDay(opts.day)) {
    console.error('--day must be YYYY-MM-DD');
    process.exit(2);
  }
  days = [opts.day];
} else days = [addDays(today, -2)];

const sections = opts.sections?.split(',').map((s) => s.trim()).filter(Boolean);
const unknown = (sections ?? []).filter((s) => !SECTIONS.includes(s));
if (unknown.length) {
  console.error(`Unknown --sections: ${unknown.join(', ')}. Sections: ${SECTIONS.join(', ')}`);
  process.exit(2);
}
// Skip days that already have a usable snapshot (the same test as --missing).
if (opts['skip-existing'] && days.length) {
  const missing = new Set(history.store.missingDays(days[0], days.at(-1)));
  days = days.filter((d) => missing.has(d));
}

console.error(`[capture] ${days.length} day(s) into ${config.historyPath}: ${days.join(', ') || '(none)'}`);
let failures = 0;
for (const day of days) {
  const started = Date.now();
  try {
    const out = await history.capture.capture({ day, ...(sections?.length ? { sections } : {}) });
    const secs = Math.round((Date.now() - started) / 1000);
    const bad = Object.entries(out.sections).filter(([, s]) => s !== 'ok').map(([k, s]) => `${k}:${s}`);
    if (Object.values(out.sections).includes('error')) failures += 1;
    console.error(
      `[capture] ${day} ok in ${secs}s: snapshot ${out.snapshotId}, ${out.metricsRecorded} metrics, findings ` +
        `${JSON.stringify(out.findings)}, anomalies ${out.anomalies.found}${bad.length ? `, not ok: ${bad.join(' ')}` : ''}`,
    );
    console.log(JSON.stringify({ day, snapshotId: out.snapshotId, sections: out.sections, cost: out.cost, findings: out.findings, errors: out.errors }));
  } catch (err) {
    failures += 1;
    console.error(`[capture] ${day} FAILED: ${err?.message ?? err}`);
    console.log(JSON.stringify({ day, error: err?.message ?? String(err) }));
  }
}
history.store.close();
process.exit(failures ? 1 : 0);

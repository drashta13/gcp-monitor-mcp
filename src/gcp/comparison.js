// Period-over-period cost comparison and anomaly detection, independent of the cost source.
// Everything is normalized to cost per day, so a 7-day week compares fairly with a 21-day baseline.

const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
const pct = (now, before) => (before > 0 ? round(((now - before) / before) * 100) : null);

// Splits a window ending at `endDate` (inclusive) into the current period and the baseline before it.
export function comparisonWindows(endDate, days, baselineDays) {
  const currentStart = addDays(endDate, -(days - 1));
  const baselineEnd = addDays(currentStart, -1);
  const baselineStart = addDays(baselineEnd, -(baselineDays - 1));
  return {
    current: { startDate: currentStart, endDate, days },
    baseline: { startDate: baselineStart, endDate: baselineEnd, days: baselineDays },
  };
}

/**
 * @param serviceDays  [{ service, day: 'YYYY-MM-DD', cost }] covering baseline + current
 * @param currentResources / baselineResources  [{ resource, service, projectId, resourceType, cost }]
 * @param threshold  % change per day that counts as a big increase
 */
export function compareCosts({
  windows,
  serviceDays,
  currentResources,
  baselineResources,
  threshold,
  limit,
  currency,
}) {
  const { current, baseline } = windows;
  const inCurrent = (d) => d >= current.startDate && d <= current.endDate;
  const inBaseline = (d) => d >= baseline.startDate && d <= baseline.endDate;

  const currentTotal = sum(serviceDays.filter((r) => inCurrent(r.day)));
  const baselineTotal = sum(serviceDays.filter((r) => inBaseline(r.day)));
  const totalPerDay = { current: currentTotal / current.days, baseline: baselineTotal / baseline.days };
  // Changes smaller than this per day are noise, however large the percentage: 0.5% of daily spend.
  const floor = Math.max(totalPerDay.current, totalPerDay.baseline) * 0.005;

  // ---- services, with a daily series for spike detection ----
  const byService = new Map();
  for (const r of serviceDays) {
    const s = byService.get(r.service) ?? byService.set(r.service, new Map()).get(r.service);
    s.set(r.day, (s.get(r.day) ?? 0) + r.cost);
  }

  const anomalies = [];
  const services = [...byService].map(([service, perDay]) => {
    const baselineSeries = dailySeries(perDay, baseline);
    const currentSeries = dailySeries(perDay, current);
    const row = changeRow(sum0(currentSeries), sum0(baselineSeries), windows);
    const flags = flagsFor(row, threshold, floor);

    // A day is a spike when it sits far above the baseline's normal range (mean + 3 standard deviations)
    // and above the rest of its own week, so a steady step up reads as an increase, not seven spikes.
    const { mean, sd } = stats(baselineSeries);
    const weekMedian = median(currentSeries);
    const spikes = currentSeries
      .map((cost, i) => ({ day: addDays(current.startDate, i), cost }))
      .filter((d) => d.cost - mean > Math.max(3 * sd, floor) && d.cost - weekMedian > floor && mean + sd > 0);
    if (spikes.length) {
      // The spike explains the higher weekly average; don't report it twice.
      const i = flags.indexOf('increase');
      if (i >= 0) flags.splice(i, 1);
      flags.push('spike');
    }

    for (const flag of flags) {
      anomalies.push({
        type: flag,
        scope: 'service',
        name: service,
        ...row,
        ...(flag === 'spike'
          ? { spikeDays: spikes.map((d) => ({ day: d.day, cost: round(d.cost) })), baselineDailyMean: round(mean) }
          : {}),
      });
    }
    return { service, ...row, ...(flags.length ? { flags } : {}) };
  });
  services.sort((a, b) => b.currentPerDay - a.currentPerDay);

  // ---- resources ----
  const key = (r) => JSON.stringify([r.projectId, r.service, r.resource]);
  const resources = new Map();
  const add = (list, field) => {
    for (const raw of list) {
      const r = foldJobs(raw);
      const e =
        resources.get(key(r)) ??
        resources
          .set(key(r), {
            resource: r.resource,
            service: r.service,
            projectId: r.projectId,
            resourceType: r.resourceType,
            current: 0,
            baseline: 0,
          })
          .get(key(r));
      e[field] += r.cost;
    }
  };
  add(currentResources, 'current');
  add(baselineResources, 'baseline');

  const resourceRows = [...resources.values()].map(({ current: c, baseline: b, ...id }) => {
    const row = changeRow(c, b, windows);
    const flags = flagsFor(row, threshold, floor);
    for (const flag of flags) anomalies.push({ type: flag, scope: 'resource', name: id.resource, ...id, ...row });
    return { ...id, ...row, ...(flags.length ? { flags } : {}) };
  });
  // The resources worth reading about are the ones whose daily cost moved most, either way.
  resourceRows.sort((a, b) => Math.abs(b.deltaPerDay) - Math.abs(a.deltaPerDay));

  anomalies.sort((a, b) => Math.abs(b.deltaPerDay) - Math.abs(a.deltaPerDay));

  return {
    currency,
    current: { ...current, total: round(currentTotal), perDay: round(totalPerDay.current) },
    baseline: { ...baseline, total: round(baselineTotal), perDay: round(totalPerDay.baseline) },
    changePct: pct(totalPerDay.current, totalPerDay.baseline),
    deltaPerDay: round(totalPerDay.current - totalPerDay.baseline),
    thresholds: { increasePct: threshold, minDeltaPerDay: round(floor), spike: 'day above baseline mean + 3 SD' },
    anomalies: anomalies.slice(0, limit),
    services: services.slice(0, limit),
    resources: resourceRows.slice(0, limit),
  };
}

function changeRow(current, baseline, { current: cw, baseline: bw }) {
  const currentPerDay = current / cw.days;
  const baselinePerDay = baseline / bw.days;
  return {
    current: round(current),
    currentPerDay: round(currentPerDay),
    baselinePerDay: round(baselinePerDay),
    deltaPerDay: round(currentPerDay - baselinePerDay),
    changePct: pct(currentPerDay, baselinePerDay),
  };
}

// new: no baseline spend. stopped: spend went to zero. increase / decrease: past the threshold.
// All need the daily change to clear the noise floor.
function flagsFor(row, threshold, floor) {
  const delta = Math.abs(row.currentPerDay - row.baselinePerDay);
  if (delta < floor) return [];
  if (row.baselinePerDay === 0) return ['new'];
  if (row.currentPerDay === 0) return ['stopped'];
  if (row.changePct >= threshold) return ['increase'];
  if (row.changePct <= -threshold) return ['decrease'];
  return [];
}

function dailySeries(perDay, { startDate, days }) {
  return Array.from({ length: days }, (_, i) => perDay.get(addDays(startDate, i)) ?? 0);
}

function stats(values) {
  if (!values.length) return { mean: 0, sd: 0 };
  const mean = sum0(values) / values.length;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
  return { mean, sd };
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const sum = (rows) => rows.reduce((a, r) => a + r.cost, 0);
const sum0 = (values) => values.reduce((a, v) => a + v, 0);

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "//bigquery.googleapis.com/projects/p/jobs/<id>" -> "//bigquery.googleapis.com/projects/p/jobs/*".
function foldJobs(r) {
  const m = /^(\/\/bigquery\.googleapis\.com\/projects\/[^/]+\/jobs\/)/.exec(r.resource ?? '');
  return m ? { ...r, resource: `${m[1]}*`, resourceType: 'bigquery.googleapis.com/Job (all jobs)' } : r;
}

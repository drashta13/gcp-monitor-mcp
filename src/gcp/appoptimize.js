import { AppOptimizeClient } from '@google-cloud/appoptimize';
import { ConfigError } from './errors.js';
import { checkProjectIds, mapLimit, round, fromMap, dateIn } from './util.js';
import { compareCosts, comparisonWindows, addDays } from './comparison.js';

// Cost source behind the Cloud Monitoring "Cost Explorer" page: the App Optimize API (v1beta, Preview).
// No billing export or billing-account access needed, but costs are list/contract prices before
// credits and committed-use discounts. History reaches back about a year (measured October 2026: data to
// ~12 months ago); a day older than that comes back empty, not as an error.

// The API only accepts certain dimension combinations (plus any of day/month/hour), so each groupBy maps to
// an allowed set and a key built from it. product_display_name is in every set so the service filter
// always applies to a selected dimension.
const SUMMARY = {
  service: { dims: ['product_display_name'], key: (r) => r.product_display_name },
  project: { dims: ['product_display_name', 'project'], key: (r) => stripProject(r.project) },
  sku: {
    dims: ['location', 'product_display_name', 'project', 'sku'],
    key: (r) => `${r.product_display_name} / ${r.sku}`,
  },
  region: { dims: ['location', 'product_display_name', 'project', 'sku'], key: (r) => r.location },
};
const TREND_DIMS = ['product_display_name', 'day'];
const RESOURCE_DIMS = ['location', 'product_display_name', 'project', 'resource', 'resource_type'];

const MAX_ROWS = 50_000; // per project
const CONCURRENCY = 4;
const PAGE_SIZE = 1000;
const TZ = 'America/Los_Angeles'; // App Optimize buckets days in Pacific Time
const LOOKBACK_DAYS = 365; // how far back the comparison may reach before App Optimize returns empty days
// A report this server created but never deleted (crash, client killed mid-call) is readable by anyone
// with appoptimize.reports.getData on the home project; sweep such leftovers on the first call.
const STALE_REPORT_MS = 60 * 60_000;
const REPORT_ID_RE = /\/reports\/mcp-([a-z0-9]+)-[a-z0-9]+$/;

export const APP_OPTIMIZE_NOTE =
  'Data comes from the App Optimize API (the source of Cloud Monitoring Cost Explorer). Costs are at list or ' +
  'contract prices BEFORE credits and committed-use discounts, reach back about a year, lag usage by up to ' +
  'a day, and days are in Pacific Time.';

export function createAppOptimizeService(config, injected) {
  const { reportProject, allowedProjects } = config;
  const parent = `projects/${reportProject}/locations/global`;
  let client = injected;
  // Reports only include `day` when a tool needs a time series: every extra dimension multiplies the rows
  // to page through (11 days = 11x the rows). If the API ever refuses to filter on an unselected `day`,
  // we fall back to always selecting it.
  let alwaysSelectDay = false;
  let swept = false;

  // Project IDs a call covers: the requested ones (checked against the allowlist), else the allowlist,
  // else just the report project.
  function projectList(projectIds) {
    const ids = checkProjectIds(projectIds, allowedProjects);
    return ids.length ? ids : allowedProjects.length ? allowedProjects : [reportProject];
  }

  // A report accepts only one scope, so run one report per project and merge the rows. A project that
  // fails (e.g. missing billing.resourceCosts.get) is reported in `failed` instead of sinking the call,
  // unless every project fails. (Not perProject(): "API disabled" here means the home project's App
  // Optimize API is off, which is a failure, not a project that doesn't use the service.)
  async function run({ projectIds, ...args }) {
    if (!reportProject) {
      throw new ConfigError(
        'No cost source configured. Set GCP_COST_REPORT_PROJECT (a project where reports are created) ' +
          'or GCP_BILLING_EXPORT_TABLE (BigQuery billing export).',
      );
    }
    const ids = projectList(projectIds);
    try {
      client ??= new AppOptimizeClient();
      await client.initialize?.(); // fail once on bad credentials instead of in every parallel report
      if (!swept) {
        swept = true;
        await sweepStaleReports().catch((err) => log(`could not sweep stale reports: ${err.message}`));
      }
      const results = await mapLimit(ids, CONCURRENCY, (id) => runReport(id, args));
      const failed = [];
      const rows = [];
      const truncatedIn = [];
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') return failed.push({ projectId: ids[i], error: r.reason?.message ?? String(r.reason) });
        rows.push(...r.value.rows);
        if (r.value.truncated) truncatedIn.push(ids[i]);
      });
      if (failed.length === ids.length) throw results[0].reason;
      return {
        rows,
        notes: {
          ...(failed.length ? { failedProjects: failed } : {}),
          ...(truncatedIn.length
            ? {
                rowsTruncatedIn: truncatedIn,
                truncatedNote:
                  `Reports were cut off at ${MAX_ROWS} rows per project, so totals for these projects are lower ` +
                  'bounds. Narrow the dates or use a coarser groupBy.',
              }
            : {}),
        },
      };
    } catch (err) {
      if (!injected) client = undefined; // rebuild after auth errors, so fixing credentials needs no restart
      throw err;
    }
  }

  // Creates a report scoped to one project, waits for it, reads every page, then deletes it.
  async function runReport(projectId, args) {
    try {
      return await createAndRead(projectId, args);
    } catch (err) {
      const filterNeedsDay =
        !alwaysSelectDay &&
        err?.code === 3 &&
        /filter/i.test(err.message) &&
        !/dimension combination/i.test(err.message);
      if (!filterNeedsDay) throw err;
      alwaysSelectDay = true;
      return createAndRead(projectId, args);
    }
  }

  async function createAndRead(projectId, { dimensions, startDate, endDate, service }) {
    const filter = [
      `day >= timestamp('${pacificMidnight(startDate)}')`,
      `day < timestamp('${pacificMidnight(addDays(endDate, 1))}')`,
      service ? `product_display_name == ${quote(service)}` : null,
    ]
      .filter(Boolean)
      .join(' && ');

    // The id carries its creation time (base36 ms) so a stale report can be recognised and swept later.
    const reportId = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let name = `${parent}/reports/${reportId}`;
    try {
      const [operation] = await client.createReport({
        parent,
        reportId,
        report: {
          dimensions: alwaysSelectDay ? [...new Set([...dimensions, 'day'])] : dimensions,
          metrics: ['cost'],
          scopes: [{ project: `projects/${projectId}` }],
          filter,
        },
      });
      const [report] = await operation.promise();
      name = report?.name ?? name;

      const rows = [];
      let pageToken;
      let truncated = false;
      do {
        const [, , response] = await client.readReport({ name, pageSize: PAGE_SIZE, pageToken }, { autoPaginate: false });
        rows.push(...(response.rows ?? []).map((r) => toObject(r, response.columns)));
        pageToken = response.nextPageToken || undefined;
        if (pageToken && rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
      } while (pageToken);
      for (const r of rows) r.project ??= `projects/${projectId}`;
      return { rows, truncated };
    } finally {
      // Whatever happened (creation failed, polling threw, read failed), make sure the report is gone.
      deleteReport(name);
    }
  }

  // Not awaited: the result shouldn't wait on cleanup. Failures are logged, and the sweep catches leftovers.
  function deleteReport(name) {
    Promise.resolve()
      .then(() => client.deleteReport({ name, allowMissing: true }))
      .catch((err) => log(`could not delete report ${name}: ${err?.message ?? err}`));
  }

  async function sweepStaleReports() {
    if (typeof client.listReportsAsync !== 'function') return;
    const cutoff = Date.now() - STALE_REPORT_MS;
    for await (const r of client.listReportsAsync({ parent })) {
      const m = REPORT_ID_RE.exec(r.name ?? '');
      if (m && parseInt(m[1], 36) < cutoff) deleteReport(r.name);
    }
  }

  const base = (filters, notes) => ({
    startDate: filters.startDate,
    endDate: filters.endDate,
    timezone: TZ,
    source: 'app-optimize',
    pricing: 'list/contract prices before credits and committed-use discounts',
    ...notes,
  });

  return {
    note: APP_OPTIMIZE_NOTE,
    timezone: TZ,

    async summary({ groupBy, limit, ...filters }) {
      const { dims, key } = SUMMARY[groupBy];
      const { rows, notes } = await run({ ...filters, dimensions: dims });
      const groups = sumBy(rows, (r) => [key(r) ?? '(none)', r.cost.currency]);
      groups.sort((a, b) => b.amount - a.amount);
      return {
        ...base(filters, notes),
        groupBy,
        totals: totals(groups),
        rows: groups.slice(0, limit).map((g) => ({ [groupBy]: g.key[0], cost: round(g.amount), currency: g.key[1] })),
      };
    },

    async trend({ granularity, ...filters }) {
      const { rows, notes } = await run({ ...filters, dimensions: TREND_DIMS });
      const points = sumBy(rows, (r) => [bucket(r.day, granularity), r.cost.currency]);
      points.sort((a, b) => a.key[0].localeCompare(b.key[0]));
      return {
        ...base(filters, notes),
        granularity,
        service: filters.service ?? 'all',
        points: points.map((p) => ({ period: p.key[0], cost: round(p.amount), currency: p.key[1] })),
      };
    },

    // This period vs the baseline before it, per day, by service and by resource, with anomalies flagged.
    // Three report runs: daily cost per service across both windows (for spikes), and resource totals
    // for each window (resource x day would be far more rows to page through).
    async comparison({ days, baselineDays, endDate, threshold, limit, projectIds, service }, now = new Date()) {
      const today = pacificDate(now);
      // Default to the last complete day: today is partial, and yesterday can still be filling in.
      const end = endDate ?? addDays(today, -2);
      const windows = comparisonWindows(end, days, baselineDays);
      const earliest = addDays(today, -LOOKBACK_DAYS);
      if (windows.baseline.startDate < earliest) {
        throw new ConfigError(
          `The baseline would start on ${windows.baseline.startDate}, but App Optimize only has data from ${earliest} ` +
            `(last ${LOOKBACK_DAYS} days). Shorten days or baselineDays, or move endDate later.`,
        );
      }
      if (end > today) throw new ConfigError(`endDate ${end} is in the future`);

      const filters = { projectIds, service };
      const [daily, currentRes, baselineRes] = await Promise.all([
        run({ ...filters, startDate: windows.baseline.startDate, endDate: end, dimensions: TREND_DIMS }),
        run({ ...filters, ...windows.current, dimensions: RESOURCE_DIMS }),
        run({ ...filters, ...windows.baseline, dimensions: RESOURCE_DIMS }),
      ]);

      // Costs in different currencies can't be added together.
      const allRows = [...daily.rows, ...currentRes.rows, ...baselineRes.rows];
      const currencies = [...new Set(allRows.map((r) => r.cost?.currency).filter(Boolean))];
      if (currencies.length > 1) {
        throw new ConfigError(
          `Costs come in more than one currency (${currencies.join(', ')}), so the comparison would add them ` +
            'together. Narrow projectIds to projects billed in one currency.',
        );
      }

      const resources = (rows) =>
        rows
          .filter((r) => r.resource)
          .map((r) => ({
            resource: r.resource,
            service: r.product_display_name,
            projectId: stripProject(r.project),
            resourceType: r.resource_type,
            cost: r.cost.amount,
          }));
      const notes = mergeNotes([daily.notes, currentRes.notes, baselineRes.notes]);

      return {
        source: 'app-optimize',
        timezone: TZ,
        pricing: 'list/contract prices before credits and committed-use discounts',
        service: service ?? 'all',
        ...compareCosts({
          windows,
          serviceDays: daily.rows.map((r) => ({
            service: r.product_display_name ?? '(none)',
            day: r.day,
            cost: r.cost.amount,
          })),
          currentResources: resources(currentRes.rows),
          baselineResources: resources(baselineRes.rows),
          threshold,
          limit,
          currency: currencies[0] ?? null,
        }),
        ...notes,
      };
    },

    async topResources({ limit, ...filters }) {
      const { rows, notes } = await run({ ...filters, dimensions: RESOURCE_DIMS });
      const groups = sumBy(
        rows.filter((r) => r.resource),
        (r) => [r.resource, r.product_display_name, r.project, r.resource_type, r.cost.currency],
      );
      groups.sort((a, b) => b.amount - a.amount);
      return {
        ...base(filters, notes),
        rows: groups.slice(0, limit).map((g) => ({
          resource: g.key[0],
          service: g.key[1],
          projectId: stripProject(g.key[2]),
          resourceType: g.key[3],
          cost: round(g.amount),
          currency: g.key[4],
        })),
      };
    },
  };
}

// ---- helpers (exported for tests) ----

// Converts a protobuf ListValue row into { column: value }, using the report's column schema.
// `cost` becomes { amount, currency } and `day` a YYYY-MM-DD string, whatever shape the API used.
export function toObject(row, columns) {
  const values = row.values ?? [];
  const out = {};
  columns.forEach((col, i) => (out[col.name] = decode(values[i], col)));
  if (out.cost != null) out.cost = money(out.cost);
  if (out.day != null) out.day = dayString(out.day);
  return out;
}

function decode(v, col) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('numberValue' in v) return v.numberValue;
  if ('boolValue' in v) return v.boolValue;
  if ('nullValue' in v) return null;
  if (v.listValue) {
    const items = v.listValue.values ?? [];
    // A RECORD comes back positionally, matching its nested columns.
    if (col?.columns?.length) return toObject({ values: items }, col.columns);
    return items.map((x) => decode(x));
  }
  if (v.structValue) {
    return Object.fromEntries(Object.entries(v.structValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  }
  return null;
}

function money(c) {
  if (typeof c === 'number') return { amount: c, currency: null };
  const currency = c.currency_code ?? c.currencyCode ?? null;
  const amount = Number(c.units ?? 0) + Number(c.nanos ?? 0) / 1e9;
  return { amount, currency };
}

// "2026-10-01", "2026-10-01T07:00:00Z" (midnight Pacific) or a Timestamp { seconds } -> "2026-10-01".
function dayString(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  if (typeof v === 'object' && v.seconds != null) return dateIn(TZ, new Date(Number(v.seconds) * 1000));
  return String(v);
}

// String literal for the report filter: backslashes and quotes escaped, control characters refused.
export function quote(s) {
  if (/[\p{Cc}]/u.test(s)) throw new ConfigError('service must not contain control characters');
  return `'${s.replace(/[\\']/g, (c) => `\\${c}`)}'`;
}

function sumBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    const id = JSON.stringify(key);
    const g = map.get(id) ?? map.set(id, { key, amount: 0 }).get(id);
    g.amount += r.cost?.amount ?? 0;
  }
  return [...map.values()];
}

function totals(groups) {
  const out = new Map();
  for (const g of groups) {
    const cur = g.key.at(-1);
    const t = out.get(cur) ?? out.set(cur, { cost: 0, groups: 0 }).get(cur);
    t.cost += g.amount;
    t.groups += 1;
  }
  for (const t of out.values()) t.cost = round(t.cost);
  return fromMap(out);
}

function mergeNotes(list) {
  const uniq = (key) => [...new Map(list.flatMap((n) => n[key] ?? []).map((x) => [x.projectId ?? x, x])).values()];
  const failed = uniq('failedProjects');
  const truncated = uniq('rowsTruncatedIn');
  return {
    ...(failed.length ? { failedProjects: failed } : {}),
    ...(truncated.length ? { rowsTruncatedIn: truncated, truncatedNote: list.find((n) => n.truncatedNote)?.truncatedNote } : {}),
  };
}

export function bucket(day, granularity) {
  if (granularity === 'month') return day.slice(0, 7);
  if (granularity === 'week') {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
    return d.toISOString().slice(0, 10);
  }
  return day;
}

// Today's date in Pacific Time, YYYY-MM-DD.
export function pacificDate(now = new Date()) {
  return dateIn(TZ, now);
}

// ISO timestamp for 00:00 Pacific on the given date, with the offset in force *at that midnight*
// (on a DST switch day the offset changes at 02:00, so sampling noon would be an hour off).
export function pacificMidnight(date) {
  const wanted = Date.parse(`${date}T00:00:00Z`); // the wall-clock time we want, as a UTC number
  let instant = wanted + 8 * 3600_000; // first guess: PST
  for (let i = 0; i < 2; i++) instant -= wallClock(instant) - wanted;
  const offsetMinutes = Math.round((wanted - instant) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${date}T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Pacific wall-clock reading of an instant, expressed as a UTC timestamp of the same digits.
function wallClock(instant) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return Date.UTC(+g.year, g.month - 1, +g.day, +g.hour, +g.minute, +g.second);
}

const pad = (n) => String(n).padStart(2, '0');

const stripProject = (v) => (typeof v === 'string' ? v.replace(/^projects\//, '') : v);

const log = (msg) => console.error(`[gcp-monitor-mcp] ${msg}`);

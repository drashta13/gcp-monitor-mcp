import { AppOptimizeClient } from '@google-cloud/appoptimize';
import { ConfigError } from './billing.js';
import { mapLimit } from './util.js';
import { compareCosts, comparisonWindows, addDays as shiftDays } from './comparison.js';

// Cost source behind the Cloud Monitoring "Cost Explorer" page: the App Optimize API (v1beta, Preview).
// No billing export or billing-account access needed, but costs are list/contract prices before
// credits and committed-use discounts, and only the last ~30 days are available.

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
const LOOKBACK_DAYS = 30;

export const APP_OPTIMIZE_NOTE =
  'Data comes from the App Optimize API (the source of Cloud Monitoring Cost Explorer). Costs are at list or ' +
  'contract prices BEFORE credits and committed-use discounts, cover at most the last 30 days, lag usage by up to ' +
  'a day, and days are in Pacific Time.';

export function createAppOptimizeService(config, injected) {
  const { reportProject, allowedProjects } = config;
  let client = injected;
  // Reports only include `day` when a tool needs a time series: every extra dimension multiplies the rows
  // to page through (11 days = 11x the rows). If the API ever refuses to filter on an unselected `day`,
  // we fall back to always selecting it.
  let alwaysSelectDay = false;

  // Project IDs a call covers: the requested ones (checked against the allowlist), else the allowlist,
  // else just the report project.
  function projectList(projectIds = []) {
    if (allowedProjects.length) {
      const denied = projectIds.filter((p) => !allowedProjects.includes(p));
      if (denied.length) throw new ConfigError(`Projects not in GCP_MONITOR_ALLOWED_PROJECTS: ${denied.join(', ')}`);
    }
    return projectIds.length ? projectIds : allowedProjects.length ? allowedProjects : [reportProject];
  }

  // A report accepts only one scope, so run one report per project and merge the rows. A project that
  // fails (e.g. missing billing.resourceCosts.get) is reported in `failed` instead of sinking the call,
  // unless every project fails.
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
      const results = await mapLimit(ids, CONCURRENCY, (id) => runReport(id, args));
      const failed = [];
      const rows = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') rows.push(...r.value);
        else failed.push({ projectId: ids[i], error: r.reason?.message ?? String(r.reason) });
      });
      if (failed.length === ids.length) throw results[0].reason;
      return { rows, failed };
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
    const parent = `projects/${reportProject}/locations/global`;
    const filter = [
      `day >= timestamp('${pacificMidnight(startDate)}')`,
      `day < timestamp('${pacificMidnight(addDays(endDate, 1))}')`,
      service ? `product_display_name == '${service.replaceAll("'", "\\'")}'` : null,
    ]
      .filter(Boolean)
      .join(' && ');

    const [operation] = await client.createReport({
      parent,
      reportId: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      report: {
        dimensions: alwaysSelectDay ? [...new Set([...dimensions, 'day'])] : dimensions,
        metrics: ['cost'],
        scopes: [{ project: `projects/${projectId}` }],
        filter,
      },
    });
    const [report] = await operation.promise();

    try {
      const rows = [];
      let pageToken;
      do {
        const [, , response] = await client.readReport(
          { name: report.name, pageSize: PAGE_SIZE, pageToken },
          { autoPaginate: false },
        );
        rows.push(...(response.rows ?? []).map((r) => toObject(r, response.columns)));
        pageToken = response.nextPageToken || undefined;
      } while (pageToken && rows.length < MAX_ROWS);
      for (const r of rows) r.project ??= `projects/${projectId}`;
      return rows;
    } finally {
      client.deleteReport({ name: report.name, allowMissing: true }).catch(() => {});
    }
  }

  const base = (filters, failed) => ({
    startDate: filters.startDate,
    endDate: filters.endDate,
    timezone: TZ,
    source: 'app-optimize',
    pricing: 'list/contract prices before credits and committed-use discounts',
    ...(failed.length ? { failedProjects: failed } : {}),
  });

  return {
    note: APP_OPTIMIZE_NOTE,

    async summary({ groupBy, limit, ...filters }) {
      const { dims, key } = SUMMARY[groupBy];
      const { rows, failed } = await run({ ...filters, dimensions: dims });
      const groups = sumBy(rows, (r) => [key(r) ?? '(none)', r.cost.currency]);
      groups.sort((a, b) => b.amount - a.amount);
      return {
        ...base(filters, failed),
        groupBy,
        totals: totals(groups),
        rows: groups.slice(0, limit).map((g) => ({ [groupBy]: g.key[0], cost: round(g.amount), currency: g.key[1] })),
      };
    },

    async trend({ granularity, ...filters }) {
      const { rows, failed } = await run({ ...filters, dimensions: TREND_DIMS });
      const points = sumBy(rows, (r) => [bucket(r.day, granularity), r.cost.currency]);
      points.sort((a, b) => a.key[0].localeCompare(b.key[0]));
      return {
        ...base(filters, failed),
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
      const end = endDate ?? shiftDays(today, -2);
      const windows = comparisonWindows(end, days, baselineDays);
      const earliest = shiftDays(today, -LOOKBACK_DAYS);
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
      const failed = [...daily.failed, ...currentRes.failed, ...baselineRes.failed].filter(
        (f, i, all) => all.findIndex((x) => x.projectId === f.projectId) === i,
      );

      return {
        source: 'app-optimize',
        timezone: TZ,
        pricing: 'list/contract prices before credits and committed-use discounts',
        service: service ?? 'all',
        ...compareCosts({
          windows,
          serviceDays: daily.rows.map((r) => ({
            service: r.product_display_name ?? '(none)',
            day: String(r.day).slice(0, 10),
            cost: r.cost.amount,
          })),
          currentResources: resources(currentRes.rows),
          baselineResources: resources(baselineRes.rows),
          threshold,
          limit,
          currency: daily.rows[0]?.cost.currency ?? currentRes.rows[0]?.cost.currency ?? null,
        }),
        ...(failed.length ? { failedProjects: failed } : {}),
      };
    },

    async topResources({ limit, ...filters }) {
      const { rows, failed } = await run({ ...filters, dimensions: RESOURCE_DIMS });
      const groups = sumBy(
        rows.filter((r) => r.resource),
        (r) => [r.resource, r.product_display_name, r.project, r.resource_type, r.cost.currency],
      );
      groups.sort((a, b) => b.amount - a.amount);
      return {
        ...base(filters, failed),
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
export function toObject(row, columns) {
  const values = row.values ?? [];
  const out = {};
  columns.forEach((col, i) => (out[col.name] = decode(values[i], col)));
  if (out.cost) out.cost = money(out.cost);
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
  const out = {};
  for (const g of groups) {
    const cur = g.key.at(-1);
    out[cur] ??= { cost: 0, groups: 0 };
    out[cur].cost += g.amount;
    out[cur].groups += 1;
  }
  for (const t of Object.values(out)) t.cost = round(t.cost);
  return out;
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
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}

// ISO timestamp for 00:00 Pacific on the given date, with the right PST/PDT offset.
export function pacificMidnight(date) {
  const utcNoon = new Date(`${date}T12:00:00Z`);
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(utcNoon)
    .find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-07:00"
  return `${date}T00:00:00${tzName.replace('GMT', '')}`;
}

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const round = (n) => Math.round(n * 100) / 100;

const stripProject = (v) => (typeof v === 'string' ? v.replace(/^projects\//, '') : v);

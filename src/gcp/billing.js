import { BigQuery } from '@google-cloud/bigquery';
import { isDetailedExport } from '../config.js';
import { ConfigError } from './errors.js';
import { checkProjectIds, round, fromMap } from './util.js';

export { ConfigError };

// Whitelisted SQL for each dimension. User input never reaches the query text,
// only these fixed expressions and bound parameters.
export const GROUP_BY = {
  service: 'service.description',
  project: 'project.id',
  sku: "CONCAT(service.description, ' / ', sku.description)",
  region: "IFNULL(location.region, 'global')",
};

export const GRANULARITY = { day: 'DAY', week: 'WEEK(MONDAY)', month: 'MONTH' };

const CREDITS = 'IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)';

// Shared filter. _PARTITIONTIME prunes partitions so we only scan the date range
// (rows land on or after their usage day; one day of slack covers timezones).
// No upper partition bound: late adjustments arrive days after usage.
const WHERE = `
  DATE(_PARTITIONTIME) >= DATE_SUB(CAST(@startDate AS DATE), INTERVAL 1 DAY)
  AND usage_start_time >= TIMESTAMP(CAST(@startDate AS DATE))
  AND usage_start_time < TIMESTAMP(DATE_ADD(CAST(@endDate AS DATE), INTERVAL 1 DAY))
  AND (ARRAY_LENGTH(@projectIds) = 0 OR project.id IN UNNEST(@projectIds))
  AND (@service IS NULL OR LOWER(service.description) = LOWER(@service))`;

const BASE_TYPES = { projectIds: ['STRING'], service: 'STRING' };

const TZ = 'UTC';

export function createBillingService(config, bigquery) {
  const { billingTable, billingQueryProject, maxBytesBilled, allowedProjects } = config;
  let bq = bigquery;

  async function run(query, params, types) {
    if (!billingTable) {
      throw new ConfigError(
        'No cost source configured. Set GCP_BILLING_EXPORT_TABLE to your BigQuery billing export table ' +
          '(project.dataset.gcp_billing_export_resource_v1_...), or set GCP_COST_REPORT_PROJECT to use the ' +
          'App Optimize API (Cost Explorer) instead.',
      );
    }
    bq ??= new BigQuery({ projectId: billingQueryProject });
    const [rows] = await bq.query({
      query,
      params,
      types: { ...BASE_TYPES, ...types },
      maximumBytesBilled: String(maxBytesBilled),
    });
    return rows;
  }

  // Requested projects narrowed to the allowlist. Empty result means "every project in the table".
  function scopeProjects(projectIds) {
    const ids = checkProjectIds(projectIds, allowedProjects);
    return ids.length ? ids : allowedProjects;
  }

  function baseParams({ startDate, endDate, projectIds, service }) {
    return { startDate, endDate, projectIds: scopeProjects(projectIds), service: service ?? null };
  }

  return {
    timezone: TZ,

    async summary({ groupBy, limit, ...filters }) {
      const rows = await run(
        `SELECT
           ${GROUP_BY[groupBy]} AS dim,
           currency,
           SUM(cost) AS cost,
           SUM(${CREDITS}) AS credits,
           SUM(cost) + SUM(${CREDITS}) AS net_cost,
           SUM(SUM(cost) + SUM(${CREDITS})) OVER (PARTITION BY currency) AS total_net_cost,
           COUNT(*) OVER (PARTITION BY currency) AS total_groups,
           MAX(MAX(export_time)) OVER () AS data_as_of
         FROM \`${billingTable}\`
         WHERE ${WHERE}
         GROUP BY dim, currency
         ORDER BY net_cost DESC
         LIMIT @limit`,
        { ...baseParams(filters), limit },
      );
      return {
        ...period(filters),
        groupBy,
        dataAsOf: ts(rows[0]?.data_as_of),
        totals: totalsByCurrency(rows),
        rows: rows.map((r) => ({
          [groupBy]: r.dim,
          cost: round(r.cost),
          credits: round(r.credits),
          netCost: round(r.net_cost),
          currency: r.currency,
        })),
      };
    },

    async trend({ granularity, ...filters }) {
      const part = GRANULARITY[granularity];
      const rows = await run(
        `SELECT
           DATE_TRUNC(DATE(usage_start_time), ${part}) AS bucket,
           currency,
           SUM(cost) + SUM(${CREDITS}) AS net_cost,
           MAX(MAX(export_time)) OVER () AS data_as_of
         FROM \`${billingTable}\`
         WHERE ${WHERE}
         GROUP BY bucket, currency
         ORDER BY bucket`,
        baseParams(filters),
      );
      return {
        ...period(filters),
        granularity,
        service: filters.service ?? 'all',
        dataAsOf: ts(rows[0]?.data_as_of),
        points: rows.map((r) => ({ period: r.bucket.value, netCost: round(r.net_cost), currency: r.currency })),
      };
    },

    async comparison() {
      throw new ConfigError(
        'get_cost_comparison currently runs on the App Optimize source only. Set GCP_COST_REPORT_PROJECT and unset ' +
          'GCP_BILLING_EXPORT_TABLE.',
      );
    },

    async topResources({ limit, ...filters }) {
      if (billingTable && !isDetailedExport(billingTable)) {
        throw new ConfigError(
          'Per-resource cost needs the "Detailed usage cost" export (table gcp_billing_export_resource_v1_...). ' +
            'GCP_BILLING_EXPORT_TABLE points at the standard export.',
        );
      }
      const rows = await run(
        `SELECT
           resource.name AS resource_name,
           service.description AS service_name,
           project.id AS project_id,
           currency,
           SUM(cost) + SUM(${CREDITS}) AS net_cost,
           MAX(MAX(export_time)) OVER () AS data_as_of
         FROM \`${billingTable}\`
         WHERE ${WHERE} AND resource.name IS NOT NULL
         GROUP BY resource_name, service_name, project_id, currency
         ORDER BY net_cost DESC
         LIMIT @limit`,
        { ...baseParams(filters), limit },
      );
      return {
        ...period(filters),
        dataAsOf: ts(rows[0]?.data_as_of),
        rows: rows.map((r) => ({
          resource: r.resource_name,
          service: r.service_name,
          projectId: r.project_id,
          netCost: round(r.net_cost),
          currency: r.currency,
        })),
      };
    },
  };
}

const period = ({ startDate, endDate }) => ({ startDate, endDate, timezone: TZ });

const ts = (v) => v?.value ?? v ?? null;

function totalsByCurrency(rows) {
  const totals = new Map();
  for (const r of rows) {
    if (!totals.has(r.currency)) totals.set(r.currency, { netCost: round(r.total_net_cost), groups: r.total_groups });
  }
  return fromMap(totals);
}

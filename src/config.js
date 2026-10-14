// Fully qualified BigQuery table: project.dataset.table. Table names can't be
// query parameters, so this validation is what keeps the SQL injection-free.
const TABLE_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.\w{1,1024}\.\w{1,1024}$/;

const DEFAULT_MAX_BYTES_BILLED = 5 * 1024 ** 3; // 5 GiB, roughly $0.03 on-demand

export function loadConfig(env = process.env) {
  const allowedProjects = (env.GCP_MONITOR_ALLOWED_PROJECTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const billingTable = env.GCP_BILLING_EXPORT_TABLE?.trim() || null;
  if (billingTable && !TABLE_RE.test(billingTable)) {
    throw new Error(`GCP_BILLING_EXPORT_TABLE must look like "project.dataset.table", got "${billingTable}"`);
  }

  const maxBytesBilled = Number(env.GCP_BQ_MAX_BYTES_BILLED ?? DEFAULT_MAX_BYTES_BILLED);
  if (!Number.isSafeInteger(maxBytesBilled) || maxBytesBilled <= 0) {
    throw new Error('GCP_BQ_MAX_BYTES_BILLED must be a positive integer number of bytes');
  }

  return {
    allowedProjects,
    billingTable,
    // Project that runs (and pays for) the BigQuery jobs. Defaults to the table's project.
    billingQueryProject: env.GCP_BILLING_QUERY_PROJECT?.trim() || billingTable?.split('.')[0],
    maxBytesBilled,
    // Project that owns App Optimize cost reports, used when there is no billing export table.
    reportProject: env.GCP_COST_REPORT_PROJECT?.trim() || null,
  };
}

export const isDetailedExport = (table) => /\.gcp_billing_export_resource_v1_/.test(table ?? '');

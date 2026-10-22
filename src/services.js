import { createProjectsService } from './gcp/projects.js';
import { createBillingService } from './gcp/billing.js';
import { createAppOptimizeService } from './gcp/appoptimize.js';
import { createInventoryService } from './gcp/inventory.js';
import { createUsageService } from './gcp/metrics.js';
import { createProjectScope } from './gcp/util.js';
import { createRest } from './gcp/rest.js';
import { createSqlHealthService } from './gcp/sqlhealth.js';
import { createGkeHealthService } from './gcp/gkehealth.js';
import { createVmHealthService } from './gcp/vmhealth.js';
import { createIncidentsService } from './gcp/incidents.js';
import { createLogsService } from './gcp/logs.js';
import { openHistoryDb } from './history/db.js';
import { createHistoryStore } from './history/store.js';
import { createCaptureService } from './history/capture.js';

// Builds every service from the config. Shared by the MCP server (index.js) and the capture CLI.
export function createServices(config) {
  // The BigQuery billing export is the accurate source (net of credits). Without it, fall back to
  // the App Optimize API that powers Cloud Monitoring's Cost Explorer.
  const useExport = Boolean(config.billingTable) || !config.reportProject;
  const projects = createProjectsService(config);
  const scope = createProjectScope(config, projects);
  const usage = createUsageService({ scope });
  const rest = createRest();
  const billing = useExport ? createBillingService(config) : createAppOptimizeService(config);
  const inventory = createInventoryService({ scope });
  const health = {
    cloudsql: createSqlHealthService({ scope, rest, usage }),
    gke: createGkeHealthService({ scope, rest, usage }),
    vm: createVmHealthService({ scope, rest, usage }),
    incidents: createIncidentsService({ scope, rest, usage }),
    logs: createLogsService({ scope, rest }),
  };

  // Local history database for scheduled daily snapshots and reports.
  let history = null;
  if (config.historyEnabled) {
    const store = createHistoryStore(openHistoryDb(config.historyPath), { path: config.historyPath });
    const capture = createCaptureService({
      billing,
      health,
      usage,
      inventory,
      store,
      costSource: useExport ? 'bigquery-export' : 'app-optimize',
      retentionDays: config.historyDays,
    });
    history = { store, capture };
  }

  const costSource = config.billingTable
    ? `billing export ${config.billingTable}`
    : config.reportProject
      ? `App Optimize via ${config.reportProject}`
      : 'none configured';

  return { projects, billing, inventory, usage, health, history, costSource };
}

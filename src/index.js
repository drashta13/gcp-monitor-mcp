#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
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

// stdout is the MCP channel: log with console.error only.
//
// Google client libraries can leave a stray rejected promise behind when credentials are
// missing. Log it instead of letting it kill the server; the tool call already reported it.
process.on('unhandledRejection', (err) => console.error('[gcp-monitor-mcp] unhandled rejection:', err?.message ?? err));

const config = loadConfig();
// The BigQuery billing export is the accurate source (net of credits). Without it, fall back to
// the App Optimize API that powers Cloud Monitoring's Cost Explorer.
const useExport = Boolean(config.billingTable) || !config.reportProject;
const projects = createProjectsService(config);
const scope = createProjectScope(config, projects);
const usage = createUsageService({ scope });
const rest = createRest();
const server = createServer({
  projects,
  billing: useExport ? createBillingService(config) : createAppOptimizeService(config),
  inventory: createInventoryService({ scope }),
  usage,
  health: {
    cloudsql: createSqlHealthService({ scope, rest, usage }),
    gke: createGkeHealthService({ scope, rest, usage }),
    vm: createVmHealthService({ scope, rest, usage }),
    incidents: createIncidentsService({ scope, rest, usage }),
    logs: createLogsService({ scope, rest }),
  },
});

await server.connect(new StdioServerTransport());
console.error(
  `gcp-monitor-mcp ready (cost source: ${useExport ? `billing export ${config.billingTable ?? '(not set)'}` : `App Optimize via ${config.reportProject}`}, ` +
    `allowed projects: ${config.allowedProjects.join(', ') || 'all'})`,
);

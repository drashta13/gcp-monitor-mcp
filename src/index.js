#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { createServices } from './services.js';

// stdout is the MCP channel: log with console.error only.
//
// Google client libraries can leave a stray rejected promise behind when credentials are missing or
// expired; the tool call has already reported that, so just log it. Anything else is a real bug (a
// forgotten await): log the stack and exit so the client restarts a clean server.
const CREDENTIAL_ERROR = /Could not load the default credentials|Unable to read the credential file|invalid_grant|reauth/i;
process.on('unhandledRejection', (err) => {
  const msg = err?.message ?? String(err);
  if (CREDENTIAL_ERROR.test(msg)) {
    console.error('[gcp-monitor-mcp] unhandled rejection (credentials):', msg);
    return;
  }
  console.error('[gcp-monitor-mcp] unhandled rejection, exiting:', err?.stack ?? msg);
  process.exit(1);
});

const config = loadConfig();
const { costSource, ...services } = createServices(config);
if (services.history) process.on('exit', () => services.history.store.close());

const server = createServer(services);

await server.connect(new StdioServerTransport());
console.error(
  `gcp-monitor-mcp ready (cost source: ${costSource}, allowed projects: ${config.allowedProjects.join(', ') || 'all'}, ` +
    `history: ${config.historyEnabled ? config.historyPath : 'off'})`,
);

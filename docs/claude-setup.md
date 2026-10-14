# Connect it to Claude

How to add the server to Claude Desktop or Claude Code, check that it's working, and use it. Do [Google Cloud setup](gcp-setup.md) and [Local setup](local-setup.md) first.

- [How Claude runs the server](#how-claude-runs-the-server)
- [Claude Desktop](#claude-desktop)
- [Claude Code](#claude-code)
- [Check it works](#check-it-works)
- [Tool permissions](#tool-permissions)
- [Slow tools and "still running"](#slow-tools-and-still-running)
- [After a code or config change](#after-a-code-or-config-change)
- [Example prompts](#example-prompts)
- [Report prompts](#report-prompts)

---

## How Claude runs the server

```
Claude Desktop / Claude Code
   │  starts:  node /abs/path/gcp-monitor-mcp/src/index.js   (env vars from the config)
   │  talks MCP over the child process's stdin/stdout
   ▼
gcp-monitor-mcp ──ADC (impersonating mcp-reader)──► Google Cloud APIs
```

- Claude starts its own copy of the server when the app (or a Claude Code session) starts, and stops it on quit.
- The server runs on **your machine** with **your ADC login**. Tool results (JSON) go to Claude as part of the conversation.
- Nothing is hosted, and no port is opened.

## Claude Desktop

**1. Find your absolute paths**

```bash
which node                     # e.g. /Users/you/.nvm/versions/node/v24.11.0/bin/node
cd gcp-monitor-mcp && pwd      # e.g. /Users/you/code/gcp-monitor-mcp
```

Claude Desktop starts servers with a minimal `PATH`, so a bare `"node"` often fails (always with nvm). Use the full path.

**2. Open the config file**

Claude Desktop → **Settings → Developer → Edit Config**, or open it directly:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

On macOS the folder name has a space, so quote it in the terminal:

```bash
open -e "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

**3. Add the server**

Add an `mcpServers` block. If the file already has other keys (such as `preferences`), keep them and add `mcpServers` next to them:

```json
{
  "preferences": { "...": "keep whatever is already here" },
  "mcpServers": {
    "gcp-monitor": {
      "command": "/Users/you/.nvm/versions/node/v24.11.0/bin/node",
      "args": ["/Users/you/code/gcp-monitor-mcp/src/index.js"],
      "env": {
        "GCP_COST_REPORT_PROJECT": "my-main-project",
        "GCP_MONITOR_ALLOWED_PROJECTS": "proj-a,proj-b,proj-c"
      }
    }
  }
}
```

The file must stay valid JSON: no comments and no trailing commas. Check it with:

```bash
python3 -m json.tool "$HOME/Library/Application Support/Claude/claude_desktop_config.json" >/dev/null && echo valid
```

**4. Restart Claude Desktop fully.** Quit it (⌘Q on macOS, or right-click the tray icon → Quit on Windows) and reopen it. Closing the window isn't enough.

**5. Confirm it loaded.** In a new chat, open the **+ / tools** menu (Search and tools). `gcp-monitor` should be listed with 12 tools. If it isn't, or it shows an error, read the log:

| OS | Log |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-gcp-monitor.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-gcp-monitor.log` |

```bash
tail -50 ~/Library/Logs/Claude/mcp-server-gcp-monitor.log
```

A healthy start logs `gcp-monitor-mcp ready (cost source: ..., allowed projects: ...)`.

## Claude Code

Add it once for your user, so it's available in every directory:

```bash
claude mcp add gcp-monitor --scope user \
  -e GCP_COST_REPORT_PROJECT=my-main-project \
  -e GCP_MONITOR_ALLOWED_PROJECTS=proj-a,proj-b,proj-c \
  -- node /absolute/path/to/gcp-monitor-mcp/src/index.js
```

| Scope | Stored in | Use when |
|---|---|---|
| `--scope local` (default) | your user config, this directory only | trying it out |
| `--scope user` | your user config, all directories | personal daily use |
| `--scope project` | `.mcp.json` in the current repo, committed | sharing the setup with a team. The file contains the env values, so only use it for non-secret values like these |

Manage it:

```bash
claude mcp list                 # shows gcp-monitor and whether it connected
claude mcp get gcp-monitor      # config details
claude mcp remove gcp-monitor --scope user
```

Inside a session, `/mcp` shows status and tools, and lets you reconnect after a code change.

Claude Code waits longer for tools than Claude Desktop. To raise the limit further, start it with `MCP_TOOL_TIMEOUT=120000 claude` (milliseconds).

## Check it works

Ask, in order:

1. "List my GCP projects." → `list_projects`. This proves login, impersonation and the allowlist work.
2. "What's running in proj-a?" → `list_resources`. This proves Asset Inventory access.
3. "How much CPU are my VMs using?" → `get_resource_usage`. This proves Monitoring access.
4. "Cost by service this month." → `get_cost_summary`. This proves the cost source works. The first call can take up to a minute.
5. "Is Cloud SQL healthy?" → `get_cloudsql_health`. This proves the health APIs work.

Any error message names the missing role or API. See [Troubleshooting](local-setup.md#troubleshooting).

## Tool permissions

Claude asks before using a tool the first time in a chat. Every tool here is read-only (annotated `readOnlyHint: true`), so choosing **Always allow** for `gcp-monitor` tools is reasonable. That approval doesn't cover tools from other MCP servers. Keep approving those one at a time, especially anything that writes. See [Security](security.md#7-prompt-injection-through-tool-results).

## Slow tools and "still running"

Cost reports take 15 to 60+ seconds to build in Google Cloud. Health checks across several projects and long log searches can take a while too. Claude Desktop gives up on a tool call after about 60 seconds, so these tools wait up to 45 seconds and then return:

```json
{ "status": "running", "runningForSeconds": 45, "message": "...call this tool again with exactly the same arguments in about 30 seconds..." }
```

The work keeps going in the background. Claude normally retries on its own; if it doesn't, say "try again". Results are cached for 10 minutes, so repeating a question within a chat is instant and free. The cache lives in memory and is cleared when Claude restarts.

## After a code or config change

| Changed | Do |
|---|---|
| Code (`git pull`, edits) | `npm install` if `package.json` changed, then restart Claude Desktop / `/mcp` → reconnect |
| `claude_desktop_config.json` | Fully restart Claude Desktop |
| Roles or APIs in Google Cloud | Nothing locally; wait a few minutes for IAM to apply |
| ADC login | Restart Claude so the server picks up the new credentials |

## Example prompts

- "What did I spend last month, by service, across all my projects?"
- "Show daily Cloud Run cost for the last 30 days. Any spikes?"
- "Which 10 resources cost the most this month?"
- "List everything running in proj-b, including stopped VMs."
- "Which GKE namespaces use the most CPU and memory, and how many pods run in each?"
- "Are any Cloud SQL instances idle or close to full disk over the last week?"
- "Which VMs have no snapshot schedule or are missing patches?"
- "Show OOM kills and crash loops in fs-storefront-web over the last 24 hours."
- "Who changed what in proj-a in the last 3 days?" (audit log, `changes` preset)
- "Were there any incidents or Google Cloud outages this week?"

## Report prompts

**Weekly FinOps report**

> Write this week's FinOps report: total spend vs the previous 3 weeks, spend by service and by resource, every anomaly with its likely cause, and recommended actions. Use get_cost_comparison, then get_top_cost_resources and get_resource_usage to explain the biggest movers.

**Service health report**

> Write a service health report for the last 7 days. Cover incidents (get_incidents) with likely root cause from the logs (query_logs presets errors, changes, k8s_warnings, oom around each incident time), GKE cluster and workload health, Cloud SQL uptime, failover readiness, backups and PITR, and VM CPU, memory, disk, patch status, agents and snapshots. End with a prioritized list of follow-ups.

Claude Desktop can also turn either report into an artifact or a document you can share.

# Local setup

How to install the server on your machine, log in so it can reach Google Cloud, and run it. Do [Google Cloud setup](gcp-setup.md) first.

- [Prerequisites](#prerequisites)
- [1. Get the code and install](#1-get-the-code-and-install)
- [2. Log in to Google Cloud](#2-log-in-to-google-cloud)
- [3. Configure](#3-configure)
- [4. Run it](#4-run-it)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20 or newer (tested on 22 and 24) | `node -v` |
| npm | comes with Node | `npm -v` |
| Google Cloud CLI | any recent | `gcloud --version` |
| Claude Desktop and/or Claude Code | latest | see [Claude setup](claude-setup.md) |

**Node.** If you don't have it, [nvm](https://github.com/nvm-sh/nvm) is the simplest way on macOS and Linux:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal, then
nvm install --lts
which node        # note this absolute path: Claude Desktop needs it
```

**gcloud.** Install from [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install). On macOS without Homebrew, the archive install puts it in `~/google-cloud-sdk`; run `~/google-cloud-sdk/install.sh` so `gcloud` is on your `PATH`, then open a new terminal.

## 1. Get the code and install

```bash
git clone https://github.com/<owner>/gcp-monitor-mcp.git
cd gcp-monitor-mcp
npm install
npm test          # runs offline against fakes, no Google Cloud access needed
```

Run `npm install` again whenever `package.json` changes (after a pull).

## 2. Log in to Google Cloud

The server uses **Application Default Credentials (ADC)**: the standard place Google client libraries look for credentials. You point ADC at the `mcp-reader` service account by impersonating it with your own Google login.

```bash
gcloud auth login                       # your own login for the gcloud CLI (once)

gcloud auth application-default login \
  --impersonate-service-account=mcp-reader@<home-project>.iam.gserviceaccount.com
```

A browser window opens. Sign in with the Google account that has **Service Account Token Creator** on `mcp-reader` ([GCP setup step 3](gcp-setup.md#3-let-people-impersonate-it)).

What this does:

- Writes `~/.config/gcloud/application_default_credentials.json` (on Windows `%APPDATA%\gcloud\application_default_credentials.json`). The file holds a refresh token for **your** account plus the name of the SA to impersonate. It is not a service account key.
- Every API call the server makes runs as `mcp-reader`, with only that account's read roles, no matter how much access your own account has.

Check it:

```bash
gcloud auth application-default print-access-token >/dev/null && echo "ADC OK"
```

**When to log in again:** if a tool returns "credentials are missing or expired" (`invalid_grant`, `reauth`), run the `application-default login` command again. Organizations with session-length policies force this periodically. Then restart Claude.

**Log out / revoke:**

```bash
gcloud auth application-default revoke
```

**Alternatives** (not recommended):

| Method | Command | Why not |
|---|---|---|
| Your own identity | `gcloud auth application-default login` | The server gets all *your* permissions, including write access |
| Key file | `GOOGLE_APPLICATION_CREDENTIALS=/path/key.json` | Long-lived secret on disk that can leak; see [Security](security.md#1-no-service-account-keys) |

## 3. Configure

The server reads environment variables. You set them in the Claude config ([Claude setup](claude-setup.md)), or in your shell when running it by hand.

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `GCP_COST_REPORT_PROJECT` | for cost tools (App Optimize) | `my-main-project` | Project that owns the temporary App Optimize cost reports (the SA's home project) |
| `GCP_MONITOR_ALLOWED_PROJECTS` | strongly recommended | `proj-a,proj-b,proj-c` | Comma-separated allowlist. Every tool is limited to these projects, and a request for any other project is refused. Without it the server uses every project the SA can see |
| `GCP_BILLING_EXPORT_TABLE` | instead of App Optimize | `billing-proj.billing.gcp_billing_export_resource_v1_0123AB` | BigQuery billing export table. Wins over App Optimize when set |
| `GCP_BILLING_QUERY_PROJECT` | no | `billing-proj` | Project that runs and pays for BigQuery jobs. Default: the table's project |
| `GCP_BQ_MAX_BYTES_BILLED` | no | `5368709120` | Per-query scan cap in bytes. Default 5 GiB |

There are no secrets in this list. Credentials come from ADC, never from environment variables.

## 4. Run it

The server talks MCP over **stdio**: an MCP client (Claude Desktop, Claude Code, the Inspector) starts it as a child process and exchanges JSON messages on stdin/stdout. You don't normally start it yourself.

**Smoke test from the terminal:**

```bash
GCP_COST_REPORT_PROJECT=my-main-project \
GCP_MONITOR_ALLOWED_PROJECTS=proj-a,proj-b \
npm start
```

You should see on stderr:

```
gcp-monitor-mcp ready (cost source: App Optimize via my-main-project, allowed projects: proj-a, proj-b)
```

It then waits for MCP messages. Press Ctrl+C to stop.

**MCP Inspector:** a web UI to call each tool by hand and see the raw JSON, without Claude in the loop. Best for checking permissions and APIs.

```bash
GCP_COST_REPORT_PROJECT=my-main-project \
GCP_MONITOR_ALLOWED_PROJECTS=proj-a,proj-b \
npm run inspect
```

It opens a browser tab. Click **Connect**, then **Tools → List Tools**, pick a tool, fill the inputs, **Run Tool**. Start with `list_projects`.

The Inspector's default request timeout is 10 seconds, but cost reports take 15 to 60 seconds. Raise *Request Timeout* in the Inspector's configuration panel to 60000, or retry when a tool returns `"status": "running"`.

Then connect it to Claude: [Claude setup](claude-setup.md).

## Updating

```bash
git pull
npm install
npm test
```

Then restart the client: fully quit and reopen Claude Desktop, or run `/mcp` → reconnect in Claude Code. A running server keeps the old code until it is restarted.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module '@google-cloud/...'` / `ERR_MODULE_NOT_FOUND` | Dependencies not installed after a pull | `npm install`, restart Claude |
| "Google Cloud credentials are missing or expired" | No ADC, or the login expired | Rerun `gcloud auth application-default login --impersonate-service-account=...` |
| `Permission 'iam.serviceAccounts.getAccessToken' denied` | You lack Token Creator on the SA | [GCP setup step 3](gcp-setup.md#3-let-people-impersonate-it) |
| "Permission denied" naming a role | The SA lacks a role in that project | Grant it ([step 4](gcp-setup.md#4-grant-roles-in-each-project)) |
| "A required Google Cloud API is not enabled" | API off in the project named | Enable it ([step 5](gcp-setup.md#5-enable-apis)), wait a few minutes |
| `apiNotEnabledIn: [...]` in a result | That project doesn't use the service | Nothing to do, unless it should |
| `failedProjects: [...]` in a result | One project failed, the rest worked | Read its `error` |
| `"status": "running"` | Report still building in Google Cloud | Call the same tool again with the same arguments after ~30 s |
| "Projects not in GCP_MONITOR_ALLOWED_PROJECTS" | Asked for a project outside the allowlist | Add it to the allowlist, or ask about allowed ones |
| `vmManagerOffIn` / no OS or patch data | VM Manager off in that project | [GCP setup step 7](gcp-setup.md#7-optional-agents-for-vm-health) |
| `opsAgent: false` / no memory or disk % | Ops Agent not installed on the VM | [GCP setup step 7](gcp-setup.md#7-optional-agents-for-vm-health) |
| `At most one scope must be specified` | Older version of this server | Update (the server now runs one report per project) |
| Server works in the terminal but not in Claude Desktop | Claude Desktop can't find `node` (minimal `PATH`) | Use the absolute node path in the config ([Claude setup](claude-setup.md#claude-desktop)) |

Server logs: Claude Desktop writes the server's stderr to `~/Library/Logs/Claude/mcp-server-gcp-monitor.log` (macOS) or `%APPDATA%\Claude\logs\mcp-server-gcp-monitor.log` (Windows).

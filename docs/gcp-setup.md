# Google Cloud setup

Everything you do in Google Cloud so the server can read your projects. You do this once, then once more for each project you add later.

**Summary:** create one read-only service account, give it read roles in every project you want to monitor, enable the APIs those projects use, and let the people who run the server impersonate it. No key files.

- [How access works](#how-access-works)
- [1. Pick a home project](#1-pick-a-home-project)
- [2. Create the service account](#2-create-the-service-account)
- [3. Let people impersonate it](#3-let-people-impersonate-it)
- [4. Grant roles in each project](#4-grant-roles-in-each-project)
- [5. Enable APIs](#5-enable-apis)
- [6. Set up a cost source](#6-set-up-a-cost-source)
- [7. Optional: agents for VM health](#7-optional-agents-for-vm-health)
- [Adding or removing a project](#adding-or-removing-a-project)
- [Organizations and folders](#organizations-and-folders)
- [Least privilege: narrower roles](#least-privilege-narrower-roles)
- [Check your setup](#check-your-setup)
- [What this costs](#what-this-costs)

---

## How access works

```
You (gcloud login) ──impersonate──► mcp-reader@<home-project>.iam.gserviceaccount.com
                                          │  read roles granted in each project
                                          ├─► project A
                                          ├─► project B
                                          └─► project C
```

- **One service account (SA), many projects.** A service account lives in one project (its *home project*) but can be granted roles in any project. You don't create one per project.
- **Impersonation instead of keys.** Your own Google login asks for short-lived tokens for the SA. Nothing secret is written into the repo or the Claude config. Who impersonated it, and when, shows up in the audit logs.
- **Read-only by design.** The SA only gets viewer roles. The single exception is App Optimize Admin on one project, which the cost tools need to create and delete temporary cost reports.

The examples below use these names. Replace them with yours.

```bash
HOME_PROJECT=my-main-project                       # where the SA lives (and cost reports run)
SA=mcp-reader@$HOME_PROJECT.iam.gserviceaccount.com
PROJECTS="proj-a proj-b proj-c"                    # every project to monitor, including the home project
ME=you@example.com                                 # your Google account
```

## 1. Pick a home project

Use the project you manage most closely, usually your main production project. It holds:

- the `mcp-reader` service account,
- the App Optimize cost reports (`GCP_COST_REPORT_PROJECT`), if you use that cost source.

## 2. Create the service account

**gcloud**

```bash
gcloud iam service-accounts create mcp-reader \
  --project=$HOME_PROJECT \
  --display-name="MCP read-only monitor" \
  --description="Read-only identity for gcp-monitor-mcp. Impersonated, no keys."
```

**Console:** IAM & Admin → Service Accounts → select the home project → **Create service account**. Name it `mcp-reader`, then click **Done** without granting roles on that screen (you grant them per project in step 4) and without creating a key.

> Never create a JSON key for this account. See [Security](security.md#1-no-service-account-keys).

## 3. Let people impersonate it

Each person who runs the server needs **Service Account Token Creator** on the service account itself (not on the project).

**gcloud**

```bash
gcloud iam service-accounts add-iam-policy-binding $SA \
  --project=$HOME_PROJECT \
  --member="user:$ME" \
  --role="roles/iam.serviceAccountTokenCreator"
```

**Console:** IAM & Admin → Service Accounts → click `mcp-reader` → **Principals with access** tab → **Grant access** → add the person's email → role **Service Account Token Creator**.

Granting Token Creator at project level would let that person impersonate *every* service account in the project, including powerful ones. Always grant it on this one account.

## 4. Grant roles in each project

### Roles

| Role (console name) | Role ID | Where | Needed for |
|---|---|---|---|
| **Viewer** | `roles/viewer` | every monitored project | every read the server makes (see below) |
| **App Optimize Admin** | `roles/appoptimize.admin` | **home project only** | cost tools (App Optimize source): create and delete the temporary reports. Viewer can read reports but not create them |

That's all. These two roles cover every tool.

**What Viewer covers.** Each permission the server uses, and whether `roles/viewer` includes it:

| Tool | Permissions | In Viewer |
|---|---|---|
| `list_projects` | `resourcemanager.projects.get` | ✅ |
| `list_resources` | `cloudasset.assets.searchAllResources` | ✅ |
| `get_resource_usage`, health metrics, uptime | `monitoring.timeSeries.list` | ✅ |
| `get_incidents` | `monitoring.alerts.list`, `servicehealth.events.list` | ✅ |
| `get_cloudsql_health` | `cloudsql.instances.list`, `cloudsql.backupRuns.list` | ✅ |
| `get_gke_health` | `container.clusters.list`, `logging.logEntries.list` | ✅ |
| `get_vm_health` | `compute.instances.list`, `compute.disks.list`, `compute.snapshots.list`, `compute.resourcePolicies.list`, `osconfig.inventories.list`, `osconfig.vulnerabilityReports.list` | ✅ |
| `query_logs` | `logging.logEntries.list` | ✅ |
| cost tools (App Optimize) | `billing.resourceCosts.get` (each project), `appoptimize.reports.get` / `getData` / `operations.get` (home project) | ✅ |
| cost tools (App Optimize) | `appoptimize.reports.create` / `delete` (home project) | ❌ needs App Optimize Admin |

Checked on 2026-10-14 against Google's predefined role definitions, and confirmed live for Asset Inventory and Monitoring (they worked with only Viewer granted).

**Redundant with Viewer**, so don't add them: Browser, Cloud Asset Viewer, Monitoring Viewer, Logs Viewer, Cloud SQL Viewer, Kubernetes Engine Cluster Viewer, Compute Viewer, OS Inventory Viewer, OS VulnerabilityReport Viewer, Personalized Service Health Viewer. If you already granted any, removing them changes nothing. You only need them if you replace Viewer with [narrower roles](#least-privilege-narrower-roles).

For the BigQuery billing export cost source, see [step 6](#6-set-up-a-cost-source) instead of App Optimize Admin.

### gcloud

```bash
for p in $PROJECTS; do
  gcloud projects add-iam-policy-binding $p \
    --member="serviceAccount:$SA" --role="roles/viewer" --condition=None
done

gcloud projects add-iam-policy-binding $HOME_PROJECT \
  --member="serviceAccount:$SA" --role="roles/appoptimize.admin" --condition=None
```

### Console

For each project: switch to it in the top project picker → IAM & Admin → **IAM** → **Grant access** → *New principals*: the SA email (`mcp-reader@<home-project>.iam.gserviceaccount.com`) → role **Viewer** → **Save**. In the home project, also add **App Optimize Admin**.

## 5. Enable APIs

An API has to be enabled in a project before the server can read that service there. Enable only what each project actually uses: a project without GKE doesn't need the GKE API, and the tools report it under `apiNotEnabledIn` instead of failing.

| API | Service name | Used by | Enable in |
|---|---|---|---|
| Cloud Resource Manager | `cloudresourcemanager.googleapis.com` | `list_projects`, project checks | home project |
| IAM Service Account Credentials | `iamcredentials.googleapis.com` | impersonation | home project |
| App Optimize | `appoptimize.googleapis.com` | cost tools | home project |
| Cloud Asset | `cloudasset.googleapis.com` | `list_resources` | every project |
| Cloud Monitoring | `monitoring.googleapis.com` | usage metrics, alerts, uptime | every project |
| Cloud Logging | `logging.googleapis.com` | `query_logs`, GKE events | every project (on by default) |
| Cloud SQL Admin | `sqladmin.googleapis.com` | `get_cloudsql_health` | projects with Cloud SQL |
| Kubernetes Engine | `container.googleapis.com` | `get_gke_health` | projects with GKE |
| Compute Engine | `compute.googleapis.com` | `get_vm_health` | projects with VMs |
| OS Config (VM Manager) | `osconfig.googleapis.com` | VM OS and patch data | projects with VMs, only useful once VM Manager is on ([step 7](#7-optional-agents-for-vm-health)) |
| Service Health | `servicehealth.googleapis.com` | `get_incidents` | every project |

**gcloud**

```bash
gcloud services enable cloudresourcemanager.googleapis.com iamcredentials.googleapis.com \
  appoptimize.googleapis.com --project=$HOME_PROJECT

for p in $PROJECTS; do
  gcloud services enable cloudasset.googleapis.com monitoring.googleapis.com logging.googleapis.com \
    servicehealth.googleapis.com --project=$p
  # Only where the project uses them:
  gcloud services enable sqladmin.googleapis.com container.googleapis.com compute.googleapis.com \
    osconfig.googleapis.com --project=$p
done
```

**Console:** APIs & Services → **Library** → search the API name → **Enable**, once per project. If search doesn't find one (OS Config is listed as "VM Manager (OS Config API)"), open it directly, then pick the project in the top bar:

- `https://console.cloud.google.com/apis/library/osconfig.googleapis.com`
- `https://console.cloud.google.com/apis/library/servicehealth.googleapis.com`
- `https://console.cloud.google.com/apis/library/appoptimize.googleapis.com`

API changes can take a few minutes to apply.

## 6. Set up a cost source

The cost tools read from one of two sources. Pick one.

| | **App Optimize API** (default) | **BigQuery billing export** |
|---|---|---|
| What it is | The API behind *Monitoring → Cost Explorer* | Cloud Billing's export of every charge to BigQuery |
| Needs | Project roles only (above) | Billing Account Administrator once, to turn it on |
| History | Last 30 days | From when you enable it, kept forever |
| Credits and discounts | Not applied (list/contract price) | Applied (`netCost`) |
| Per-resource cost | Yes | Only with the *Detailed usage cost* export |
| `get_cost_comparison` | Yes | Not supported yet |
| Status | Preview (v1beta) | GA |
| Server config | `GCP_COST_REPORT_PROJECT` | `GCP_BILLING_EXPORT_TABLE` (wins if both are set) |

**App Optimize:** done if you followed steps 4 and 5 (App Optimize Admin plus the API on the home project, Viewer on each project). Each tool call creates a short-lived report in the home project, reads it and deletes it.

**Billing export** (if you later get billing admin): Billing → **Billing export** → **BigQuery export** → enable **Detailed usage cost** into a dataset. Then grant the SA:

```bash
gcloud projects add-iam-policy-binding <export-project> \
  --member="serviceAccount:$SA" --role="roles/bigquery.dataViewer" --condition=None
gcloud projects add-iam-policy-binding <query-project> \
  --member="serviceAccount:$SA" --role="roles/bigquery.jobUser" --condition=None
```

Set `GCP_BILLING_EXPORT_TABLE=<project>.<dataset>.gcp_billing_export_resource_v1_<ID>`. Each query is capped by `GCP_BQ_MAX_BYTES_BILLED` (default 5 GiB, about $0.03).

## 7. Optional: agents for VM health

`get_vm_health` works without these, but some fields stay empty:

| Missing | What you lose | How to turn it on |
|---|---|---|
| **Ops Agent** on the VM | memory % and disk % (`opsAgent: false`) | Compute Engine → VM → *Observability* → install Ops Agent, or the [install guide](https://cloud.google.com/stackdriver/docs/solutions/agents/ops-agent/installation) |
| **VM Manager** in the project | OS version and patch status (`vmManagerOffIn` in the result) | [Enable full VM Manager](https://cloud.google.com/compute/docs/manage-os#enable-full-vmm): project metadata `enable-osconfig=TRUE` |

Both cost money (Ops Agent metrics and logs are billed by volume; VM Manager is billed per VM above a free tier). Check current pricing before rolling them out widely.

## Adding or removing a project

**Add:** grant Viewer as in [step 4](#4-grant-roles-in-each-project) in the new project, enable the APIs it uses ([step 5](#5-enable-apis)), and add its ID to `GCP_MONITOR_ALLOWED_PROJECTS` in your Claude config. Restart Claude.

**Remove:** take it out of `GCP_MONITOR_ALLOWED_PROJECTS`, then remove the SA's roles in that project:

```bash
gcloud projects remove-iam-policy-binding <project> --member="serviceAccount:$SA" --role="roles/viewer"
```

**Revoke everything:** disable or delete the `mcp-reader` service account. Every running server stops working immediately.

## Organizations and folders

If your projects sit in an organization or folder, grant Viewer once at that level (IAM on the org/folder) instead of per project. New projects are then covered automatically, so **still use `GCP_MONITOR_ALLOWED_PROJECTS`** to choose which ones the server reads.

## Least privilege: narrower roles

Viewer is broad: it can read the configuration of almost every service (see [Security](security.md#6-know-what-data-leaves-google-cloud)). To narrow it, replace Viewer with these predefined roles per project:

| Role | Covers |
|---|---|
| `roles/browser` | `list_projects` |
| `roles/cloudasset.viewer` | `list_resources` |
| `roles/monitoring.viewer` | usage metrics, alerts, uptime checks |
| `roles/logging.viewer` | `query_logs`, GKE events and autoscaler logs |
| `roles/cloudsql.viewer` | Cloud SQL health |
| `roles/container.clusterViewer` | GKE health |
| `roles/compute.viewer` | VM health |
| `roles/osconfig.inventoryViewer`, `roles/osconfig.vulnerabilityReportViewer` | VM OS and patch data |
| `roles/servicehealth.viewer` | Google Cloud outages in `get_incidents` |
| `roles/appoptimize.viewer` (home project) | reading App Optimize reports |
| a custom role with `billing.resourceCosts.get` | App Optimize cost read |

Keep App Optimize Admin on the home project. The trade-off is about 10 role bindings per project instead of one.

## Check your setup

```bash
# Can you impersonate the SA?
gcloud auth print-access-token --impersonate-service-account=$SA >/dev/null && echo OK

# Which roles does the SA have in a project?
gcloud projects get-iam-policy proj-a \
  --flatten="bindings[].members" --filter="bindings.members:serviceAccount:$SA" \
  --format="table(bindings.role)"

# Which APIs are on?
gcloud services list --enabled --project=proj-a
```

Then ask Claude to "list my GCP projects" (see [Claude setup](claude-setup.md)).

## What this costs

- Enabling APIs is free. Reads from Resource Manager, Asset Inventory, Cloud SQL Admin, GKE, Compute, OS Config, Service Health and Logging are free.
- Cloud Monitoring reads have a large free monthly allowance. A few reports a week won't come close to it.
- App Optimize is in preview and has shown no charges in our use. Check its pricing page if that changes.
- Billing export queries (if used) scan BigQuery and are capped per query by `GCP_BQ_MAX_BYTES_BILLED`.
- What does cost money is outside this setup: Ops Agent metric and log volume, and VM Manager per-VM fees.

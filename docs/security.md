# Security

What can go wrong with this server and how to avoid it. The short version: **read-only identity, no keys, an allowlist, and treat tool output as untrusted text.**

| # | Pitfall | Do this instead |
|---|---|---|
| 1 | [Service account keys](#1-no-service-account-keys) | Impersonation via ADC |
| 2 | [Running as your own account](#2-dont-run-as-your-own-account) | Impersonate `mcp-reader` |
| 3 | [Token Creator granted too widely](#3-grant-token-creator-on-the-service-account-only) | Grant it on the one SA, to named people |
| 4 | [Write or admin roles on the SA](#4-keep-the-service-account-read-only) | Viewer roles only; App Optimize Admin on one project |
| 5 | [No project allowlist](#5-always-set-the-project-allowlist) | Set `GCP_MONITOR_ALLOWED_PROJECTS` |
| 6 | [Sensitive data in results](#6-know-what-data-leaves-google-cloud) | Know what Viewer and logs expose |
| 7 | [Prompt injection through tool results](#7-prompt-injection-through-tool-results) | Don't auto-approve write tools in the same chat |
| 8 | [Leaking local credentials](#8-protect-the-local-credentials-file) | Protect and revoke the ADC file |
| 9 | [Committing config or secrets](#9-dont-commit-config-or-secrets) | Keep env in Claude's config; secrets never go there |
| 10 | [Exposing the server on a network](#10-keep-it-on-stdio) | stdio only |
| 11 | [Unvetted changes to the server](#11-review-changes-and-dependencies) | Review code and dependencies; pin versions |
| 12 | [No audit trail](#12-audit-and-revoke) | Audit logs; know how to revoke fast |

---

### 1. No service account keys

A JSON key (`GOOGLE_APPLICATION_CREDENTIALS=key.json`) is a long-lived password for the service account. It never expires on its own, it works from anywhere, and it ends up in Downloads folders, backups, repos and chat logs.

- Use `gcloud auth application-default login --impersonate-service-account=...`. Tokens last about an hour and are tied to your own login.
- Consider the org policy `iam.disableServiceAccountKeyCreation` so nobody can create keys for it.
- If a key ever existed: delete it (IAM & Admin → Service Accounts → `mcp-reader` → Keys) and check the audit logs for its use.

### 2. Don't run as your own account

Plain `gcloud auth application-default login` makes the server act as **you**, with every permission you have, including write and admin. A bug, or a manipulated conversation, could then reach far more than intended. Always impersonate `mcp-reader`, so the server's power is exactly the read roles you granted it.

### 3. Grant Token Creator on the service account only

`roles/iam.serviceAccountTokenCreator` lets someone act as a service account.

- Grant it **on `mcp-reader`** (service account → *Principals with access*), not on the project. At project level it covers every service account there, including ones with owner or editor rights.
- Grant it to named users, not to groups like `allUsers`, `allAuthenticatedUsers` or a whole domain.
- Review the list when people change roles.

### 4. Keep the service account read-only

- The only non-viewer role is **App Optimize Admin**, and only on the home project. It lets the SA create and delete App Optimize *reports*: temporary cost queries, nothing else.
- Never give `mcp-reader` Editor, Owner, any `*Admin` role (besides the one above), Secret Manager accessor, or `iam.serviceAccountUser`.
- If you need write tools one day, build them with a **separate** identity and server, so this one stays read-only.
- For tighter scope, replace Viewer with the narrower roles listed in [GCP setup](gcp-setup.md#least-privilege-narrower-roles).

### 5. Always set the project allowlist

Without `GCP_MONITOR_ALLOWED_PROJECTS`, the server covers every project the SA can see. If someone later grants the SA a role at folder or org level, new projects silently come into scope. With the allowlist, any other project is refused, even if the SA can read it.

### 6. Know what data leaves Google Cloud

Tool results go into the conversation, so they are sent to Claude. Know what they can contain:

| Tool | Can contain |
|---|---|
| `query_logs` | **Application log messages**: these can include user emails, IDs, IP addresses, tokens or other secrets if your apps log them, plus audit-log principals |
| `get_incidents` | Alert policy names, resource labels |
| `list_resources`, `list_projects` | Resource names and **labels** |
| health tools | Instance, cluster, VM and disk names, versions, configuration (no IPs) |
| cost tools | Spend per service/resource |

What the server never returns: secret values (Secret Manager), database contents, storage object contents, VM metadata or startup scripts, workload environment variables, Data Access audit logs.

Note that **Viewer can read more than the server returns**. For example, it can read VM metadata, and startup scripts sometimes contain secrets. The server drops those fields, but the identity could read them. If that matters to you, use the narrower roles in [GCP setup](gcp-setup.md#least-privilege-narrower-roles) and keep secrets out of metadata.

Mitigations:

- Don't log secrets or personal data in your apps. That's good practice anyway.
- Use `query_logs` with narrow `filter`, `resourceName` and `hours`, and keep `limit` low.
- Use labels for routing, not for secrets.
- Follow your organization's policy on what may be shared with AI tools. If production logs are sensitive, leave `query_logs` out of reports, or don't allowlist those projects.

### 7. Prompt injection through tool results

Log lines, resource names, labels and alert names are text that **other people or systems can write**. An attacker who can get text into your logs (a crafted URL, user agent or form field) can try to plant instructions such as "ignore previous instructions and ...". Claude reads that text as data in a tool result.

This server can't be made to *do* anything harmful: it has no write tools, and its identity can't change anything. The risk is other tools in the same chat:

- Don't give blanket **Always allow** to tools from *other* MCP servers that write (email, Slack, GitHub, shell, file system) in chats where you read logs.
- Read what Claude proposes to do after reading logs, before approving a write.
- Treat conclusions drawn from log text as evidence to verify, not fact.

### 8. Protect the local credentials file

`~/.config/gcloud/application_default_credentials.json` contains a refresh token for your Google account (scoped by impersonation). Anyone who copies it can act as `mcp-reader` until it's revoked.

- Keep full-disk encryption on, and don't sync `~/.config/gcloud` to cloud drives or dotfile repos.
- On a shared or lost machine: `gcloud auth application-default revoke`, and remove your Token Creator grant.
- Your organization can shorten Google session length so tokens re-authenticate periodically.

### 9. Don't commit config or secrets

- `claude_desktop_config.json` lives outside the repo; keep it that way.
- The env vars here are not secrets (project IDs), so `.mcp.json` with `--scope project` is acceptable, but it publishes your project IDs to everyone with repo access.
- Never put credentials in env vars in these configs. If you ever add a secret, use `.env` (already in `.gitignore`) or a secret manager.
- Run `git status` before committing to make sure no `*.json` key or `.env` slipped in.

### 10. Keep it on stdio

The server talks over stdio to a client on the same machine. It opens no port and has no authentication of its own. Don't wrap it in an HTTP or SSE bridge and expose it on a network: anyone who reached it could query your cloud as `mcp-reader`. A shared, hosted version needs its own design: OAuth in front, per-user identity, rate limits.

The MCP Inspector (`npm run inspect`) runs a local proxy with a session token. Use it on your machine only, and stop it when done.

### 11. Review changes and dependencies

The server runs with your credentials, so its code is part of your security boundary.

- Review diffs before running new versions, especially changes to `src/gcp/rest.js`, auth, or anything that adds a non-GET call. Today the only non-read calls are App Optimize report create/delete and the Logging `entries:list` POST (a read).
- Commit `package-lock.json` and install with `npm ci` for reproducible installs. Run `npm audit` periodically.
- Only use official `@google-cloud/*`, `google-auth-library` and `@modelcontextprotocol/sdk` packages.

### 12. Audit and revoke

**See what the server did:** every call is made as `mcp-reader`, so Cloud Audit Logs show it, along with who impersonated it (`serviceAccountDelegationInfo`). Admin Activity is always on. For read calls, enable Data Access logs on the APIs you care about.

```
protoPayload.authenticationInfo.principalEmail="mcp-reader@<home-project>.iam.gserviceaccount.com"
```

**Revoke fast**, from narrowest to widest:

1. One person: remove their Token Creator on `mcp-reader`.
2. One project: remove the SA's roles there and take it out of the allowlist.
3. Everyone: **disable** the `mcp-reader` service account (IAM & Admin → Service Accounts → Disable). This is reversible and stops every server immediately.

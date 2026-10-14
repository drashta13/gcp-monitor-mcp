# gcp-monitor-mcp documentation

| Doc | Read it to |
|---|---|
| [About the project](overview.md) | Understand what it does, how it's built, data sources and their limits, repo layout |
| [Google Cloud setup](gcp-setup.md) | Create the read-only service account, grant roles across projects, enable APIs, pick a cost source |
| [Local setup](local-setup.md) | Install, log in with ADC impersonation, configure, run, troubleshoot |
| [Connect it to Claude](claude-setup.md) | Add it to Claude Desktop or Claude Code, check it works, example and report prompts |
| [Tools reference](tools.md) | Every tool: purpose, inputs, outputs, how it works, and how to combine them |
| [Security](security.md) | Pitfalls to avoid and how to audit and revoke access |

## Setup in order

1. [Google Cloud setup](gcp-setup.md): service account, roles, APIs (once, plus once per new project)
2. [Local setup](local-setup.md): Node, gcloud, `npm install`, `gcloud auth application-default login --impersonate-service-account=...`
3. [Connect it to Claude](claude-setup.md): add the server to the config, restart, ask "list my GCP projects"

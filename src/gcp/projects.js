import { ProjectsClient } from '@google-cloud/resource-manager';

const MAX_PROJECTS = 500;

// Lists the active projects the current identity can see (needs resourcemanager.projects.get,
// e.g. roles/browser), narrowed to the allowlist when one is configured.
export function createProjectsService({ allowedProjects }, injected) {
  let client = injected;
  return {
    async list() {
      // Created lazily and dropped on failure, so fixing credentials doesn't need a restart.
      client ??= new ProjectsClient();
      try {
        return await search(client, allowedProjects);
      } catch (err) {
        if (!injected) client = undefined;
        throw err;
      }
    },
  };
}

async function search(client, allowedProjects) {
  const projects = [];
  for await (const p of client.searchProjectsAsync({ query: 'state:ACTIVE' }, { autoPaginate: false })) {
    if (allowedProjects.length && !allowedProjects.includes(p.projectId)) continue;
    projects.push({
      projectId: p.projectId,
      name: p.displayName,
      parent: p.parent || null,
      labels: Object.keys(p.labels ?? {}).length ? p.labels : undefined,
    });
    if (projects.length >= MAX_PROJECTS) break;
  }
  return projects.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

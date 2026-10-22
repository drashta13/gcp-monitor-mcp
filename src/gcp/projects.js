import { ProjectsClient } from '@google-cloud/resource-manager';

const MAX_PROJECTS = 500;

// Lists the active projects the current identity can see (needs resourcemanager.projects.get,
// e.g. roles/browser), narrowed to the allowlist when one is configured.
export function createProjectsService({ allowedProjects }, injected) {
  let client = injected;
  async function search() {
    // Created lazily and dropped on failure, so fixing credentials doesn't need a restart.
    client ??= new ProjectsClient();
    try {
      return await searchProjects(client, allowedProjects);
    } catch (err) {
      if (!injected) client = undefined;
      throw err;
    }
  }
  return {
    // { projects, truncated }: truncated when the identity can see more than MAX_PROJECTS.
    search,
    async list() {
      return (await search()).projects;
    },
  };
}

async function searchProjects(client, allowedProjects) {
  const projects = [];
  let truncated = false;
  for await (const p of client.searchProjectsAsync({ query: 'state:ACTIVE' })) {
    if (allowedProjects.length && !allowedProjects.includes(p.projectId)) continue;
    if (projects.length >= MAX_PROJECTS) {
      truncated = true;
      break;
    }
    projects.push({
      projectId: p.projectId,
      name: p.displayName,
      parent: p.parent || null,
      labels: Object.keys(p.labels ?? {}).length ? p.labels : undefined,
    });
  }
  return { projects: projects.sort((a, b) => a.projectId.localeCompare(b.projectId)), truncated };
}

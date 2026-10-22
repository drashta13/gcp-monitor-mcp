import { AssetServiceClient } from '@google-cloud/asset';
import { perProject, fromMap } from './util.js';

// Friendly resource kinds mapped to Cloud Asset Inventory types. `usage` names the get_resource_usage kind
// that has metrics for it.
export const KINDS = {
  vm: { types: ['compute.googleapis.com/Instance'], usage: 'vm' },
  gke: { types: ['container.googleapis.com/Cluster'], usage: 'gke' },
  cloudsql: { types: ['sqladmin.googleapis.com/Instance'], usage: 'cloudsql' },
  cloudrun: { types: ['run.googleapis.com/Service'], usage: 'cloudrun' },
  functions: {
    types: ['cloudfunctions.googleapis.com/CloudFunction', 'cloudfunctions.googleapis.com/Function'],
  },
  redis: { types: ['redis.googleapis.com/Instance'] },
  bucket: { types: ['storage.googleapis.com/Bucket'] },
  disk: { types: ['compute.googleapis.com/Disk'] },
  bigquery: { types: ['bigquery.googleapis.com/Dataset'] },
  loadbalancer: { types: ['compute.googleapis.com/ForwardingRule'] },
};

export const DEFAULT_KINDS = ['vm', 'gke', 'cloudsql', 'cloudrun', 'functions', 'redis', 'bucket'];

// States that mean "not in use". Anything else, including no state at all (buckets, datasets), counts as
// active. Asset Inventory reports each service's own state names.
const INACTIVE = new Set([
  'TERMINATED',
  'STOPPED',
  'STOPPING',
  'SUSPENDED',
  'SUSPENDING',
  'FAILED',
  'ERROR',
  'DELETING',
  'PENDING_DELETE',
  'DELETED',
]);

const MAX_PER_PROJECT = 2000;
const CONCURRENCY = 4;

const TYPE_TO_KIND = Object.fromEntries(
  Object.entries(KINDS).flatMap(([kind, { types }]) => types.map((t) => [t, kind])),
);

// Needs cloudasset.assets.searchAllResources on each project (roles/viewer or roles/cloudasset.viewer) and the Cloud
// Asset API enabled.
export function createInventoryService({ scope }, injected) {
  let client = injected;

  async function search(projectId, assetTypes) {
    const out = [];
    let truncated = false;
    const iterable = client.searchAllResourcesAsync({ scope: `projects/${projectId}`, assetTypes, pageSize: 500 });
    for await (const r of iterable) {
      if (out.length >= MAX_PER_PROJECT) {
        truncated = true;
        break;
      }
      out.push(toResource(r, projectId));
    }
    return { projectId, resources: out, truncated };
  }

  return {
    async list({ projectIds, kinds = DEFAULT_KINDS, includeInactive = false, limit = 200 }) {
      const ids = await scope(projectIds);
      const assetTypes = kinds.flatMap((k) => KINDS[k].types);
      client ??= new AssetServiceClient();
      let result;
      try {
        await client.initialize?.(); // fail once on bad credentials instead of in every parallel call
        result = await perProject(ids, CONCURRENCY, (id) => search(id, assetTypes));
      } catch (err) {
        if (!injected) client = undefined;
        throw err;
      }

      const all = dedupeFunctions(result.ok.flatMap((r) => r.resources));
      const truncatedProjects = result.ok.filter((r) => r.truncated).map((r) => r.projectId);
      const shown = includeInactive ? all : all.filter((r) => r.active);
      shown.sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) || a.projectId.localeCompare(b.projectId) || a.name.localeCompare(b.name),
      );

      const counts = new Map();
      for (const r of all) {
        const c = counts.get(r.kind) ?? counts.set(r.kind, { active: 0, inactive: 0 }).get(r.kind);
        c[r.active ? 'active' : 'inactive'] += 1;
      }

      return {
        projects: ids,
        counts: fromMap(counts),
        returned: Math.min(shown.length, limit),
        truncated: shown.length > limit,
        ...(truncatedProjects.length
          ? { truncatedProjects, truncatedNote: `Only the first ${MAX_PER_PROJECT} resources per project were read.` }
          : {}),
        resources: shown.slice(0, limit).map(({ active, ...r }) => (includeInactive ? { ...r, active } : r)),
        ...(result.failed.length ? { failedProjects: result.failed } : {}),
      };
    },
  };
}

// A 2nd-gen Cloud Function is also a Cloud Run service with the same name and location. Keep the function
// row and drop the Cloud Run duplicate so it isn't counted twice.
function dedupeFunctions(resources) {
  const fnKeys = new Set(
    resources.filter((r) => r.kind === 'functions').map((r) => `${r.projectId}/${r.location}/${r.name}`),
  );
  if (!fnKeys.size) return resources;
  return resources.filter((r) => r.kind !== 'cloudrun' || !fnKeys.has(`${r.projectId}/${r.location}/${r.name}`));
}

function toResource(r, projectId) {
  const kind = TYPE_TO_KIND[r.assetType] ?? r.assetType;
  const state = r.state || null;
  return {
    kind,
    name: r.displayName || r.name.split('/').pop(),
    projectId,
    location: r.location || null,
    state,
    active: !state || !INACTIVE.has(state.toUpperCase()),
    labels: Object.keys(r.labels ?? {}).length ? r.labels : undefined,
    created: timestamp(r.createTime),
    usageKind: KINDS[kind]?.usage,
    resourceName: r.name,
  };
}

function timestamp(t) {
  if (!t?.seconds) return null;
  return new Date(Number(t.seconds) * 1000).toISOString();
}

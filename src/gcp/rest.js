import { GoogleAuth } from 'google-auth-library';

// Thin authenticated REST client for the Google APIs that have no light Node library (Cloud SQL Admin,
// GKE, Logging, Compute, OS Config, Service Health, Monitoring alerts). Uses Application Default
// Credentials like everything else; the identity's IAM roles are what keep it read-only.
export function createRest(injected) {
  let client = injected;

  async function request(opts) {
    try {
      client ??= await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
      const res = await client.request({ retry: true, ...opts });
      return res.data;
    } catch (err) {
      if (!injected) client = undefined; // pick up fixed credentials without a restart
      throw toError(err);
    }
  }

  return {
    get: (url, params) => request({ url, params }),
    post: (url, data) => request({ url, method: 'POST', data }),

    // Follows nextPageToken until `max` items. Returns { items, truncated }.
    async list(url, { params = {}, key, max = 1000, post = false } = {}) {
      const items = [];
      let pageToken;
      do {
        const data = post
          ? await request({ url, method: 'POST', data: { ...params, pageToken } })
          : await request({ url, params: { ...params, pageToken } });
        items.push(...(data?.[key] ?? []));
        pageToken = data?.nextPageToken || undefined;
      } while (pageToken && items.length < max);
      return { items: items.slice(0, max), truncated: Boolean(pageToken) || items.length > max };
    },
  };
}

// Google API errors carry the useful part in the response body ({ error: { code, status, message } }).
function toError(err) {
  const body = err?.response?.data?.error;
  if (!body) return err;
  const out = new Error(`${body.code ?? ''} ${body.status ?? ''}: ${body.message ?? err.message}`.trim());
  out.code = body.code;
  out.status = body.status;
  return out;
}

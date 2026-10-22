import { GoogleAuth } from 'google-auth-library';

// Thin authenticated REST client for the Google APIs that have no light Node library (Cloud SQL Admin,
// GKE, Logging, Compute, OS Config, Service Health, Monitoring alerts). Uses Application Default
// Credentials like everything else; the identity's IAM roles are what keep it read-only.

// A hung request would otherwise pin a background job as "running" forever.
const TIMEOUT_MS = 60_000;

// gaxios retries only idempotent methods by default; the Logging entries:list POST is a read and the
// call most likely to hit 429/503, so retry it too.
const RETRY = { httpMethodsToRetry: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'POST'] };

export function createRest(injected) {
  let client = injected;

  async function request(opts) {
    try {
      client ??= await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
      const res = await client.request({ retry: true, retryConfig: RETRY, timeout: TIMEOUT_MS, ...opts });
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
// The original error is kept as `cause` for debugging; only the message and code are ever logged.
export function toError(err) {
  const body = err?.response?.data?.error;
  if (!body) return err;
  const out = new Error(`${body.code ?? ''} ${body.status ?? ''}: ${body.message ?? err.message}`.trim(), { cause: err });
  out.code = body.code;
  out.status = body.status;
  out.httpStatus = err.response?.status;
  return out;
}

// Segment of a Google API URL path. Project IDs are validated before they get here; this is the belt to
// that pair of braces.
export const seg = (s) => encodeURIComponent(String(s));

interface Env {
  CONFIGS: R2Bucket;
  CONNECTIONS: KVNamespace;
  SDK_ANALYTICS?: AnalyticsEngineDataset;
  POSTHOG_HOST: string;
  POSTHOG_API_KEY?: string;
}

// sdk_key is secrets.token_urlsafe(32) → ~43 chars of [A-Za-z0-9_-].
// Wide bounds so key-format changes don't 404 the read path.
const PATH_RE = /^\/([A-Za-z0-9_-]{16,128})\/flags\.json$/;

// KV free tier is 1,000 writes/day; a 5-min throttle keeps an always-on
// instance at ~288 writes/day. The Phase 4 badge threshold accounts for this.
const KV_WRITE_THROTTLE_MS = 5 * 60 * 1000;

// In-isolate memo of the last KV write time per conn key (FABLE_IMPROVEMENTS
// 4.3). Without it every poll did a KV *read*, and the free tier's ~100k
// reads/day breaks at roughly 35 always-on clients — long before the
// 1k-writes/day budget the throttle above protects. With the memo, a poll
// inside the throttle window does zero KV ops. Isolate-local by design: an
// eviction or a new colo just costs one extra read (whose result re-primes the
// memo), so writes stay globally throttled and the badge freshness is
// unchanged.
const connWriteMemo = new Map<string, number>();
// Backstop against unbounded growth (keys = active SDK keys per isolate —
// small in practice; a hostile key-scan would 404 before reaching KV anyway).
const CONN_MEMO_MAX = 10_000;

/** Test-only: clear isolate-local state between test cases. */
export function _resetForTests(): void {
  connWriteMemo.clear();
}

// The browser SDK fetches cross-origin; the R2 custom domain allowed this
// before the cutover, so the Worker must keep doing it.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    const url = new URL(request.url);
    const match = PATH_RE.exec(url.pathname);
    if (!match) {
      return jsonResponse(404, { error: "not_found" });
    }
    const sdkKey = match[1];

    // The R2 read is the only hard dependency in the read path.
    let object: R2ObjectBody | null;
    try {
      object = await env.CONFIGS.get(`${sdkKey}/flags.json`);
    } catch {
      recordRequest(env, request, sdkKey, "500", "", 0);
      return jsonResponse(500, { error: "config_unavailable" });
    }

    if (!object) {
      recordRequest(env, request, sdkKey, "404", "", 0);
      return jsonResponse(404, { error: "unknown_sdk_key" });
    }

    // The body stream can fail mid-read (truncated R2 response) — that's still
    // an R2 failure, so it takes the same controlled path as a failed .get:
    // JSON body + CORS headers + a telemetry row, never an uncontrolled 1101
    // page the browser SDK can't even read (FABLE_IMPROVEMENTS 4.1).
    let body: string;
    try {
      body = await object.text();
    } catch {
      recordRequest(env, request, sdkKey, "500", "", 0);
      return jsonResponse(500, { error: "config_unavailable" });
    }
    let configVersion = "";
    try {
      configVersion = String(JSON.parse(body).version ?? "");
    } catch {
      // Unparseable config still gets served; version just goes unrecorded.
    }

    recordRequest(env, request, sdkKey, "200", configVersion, object.size);
    ctx.waitUntil(trackConnection(env, request, sdkKey));

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Browser-side caching only — no edge cache in front of the Worker,
        // so every poll is observed.
        "Cache-Control": "public, max-age=30",
        ...CORS_HEADERS,
      },
    });
  },
};

// Analytics Engine row per request. writeDataPoint is non-blocking.
function recordRequest(
  env: Env,
  request: Request,
  sdkKey: string,
  status: string,
  configVersion: string,
  responseBytes: number,
): void {
  try {
    const cf = request.cf;
    env.SDK_ANALYTICS?.writeDataPoint({
      indexes: [sdkKey],
      blobs: [
        status,
        String(cf?.colo ?? ""),
        String(cf?.country ?? ""),
        request.headers.get("User-Agent") ?? "",
        configVersion,
      ],
      doubles: [responseBytes],
    });
  } catch {
    // Telemetry must never break the read path.
  }
}

// KV liveness upsert + first-ever-fetch detection. The KV key's absence is
// the dedup for the activation event — no extra state needed.
async function trackConnection(env: Env, request: Request, sdkKey: string): Promise<void> {
  try {
    const key = `conn:${sdkKey}`;
    const now = new Date();
    const nowMs = now.getTime();

    // Hot path: a recent write is memoized in-isolate → zero KV ops (4.3).
    const memo = connWriteMemo.get(key);
    if (memo !== undefined && nowMs - memo < KV_WRITE_THROTTLE_MS) {
      return;
    }
    if (connWriteMemo.size > CONN_MEMO_MAX) connWriteMemo.clear();

    const lastSeen = await env.CONNECTIONS.get(key);

    if (lastSeen === null) {
      // First fetch ever for this key → activation signal. KV put FIRST, then
      // the PostHog capture (FABLE_IMPROVEMENTS 4.4): the key's absence is the
      // dedup, so a capture-before-put that failed the put would re-fire
      // sdk_first_fetch on every poll. A lost capture after a successful put
      // is the cheaper error. (Cross-colo KV consistency can still double-fire
      // for multi-region fleets — known analytics noise, read the funnel
      // accordingly.) A rotated key re-fires this; harmless — both keys alias
      // to the same PostHog person.
      await env.CONNECTIONS.put(key, now.toISOString());
      connWriteMemo.set(key, nowMs);
      await captureFirstFetch(env, request, sdkKey, now);
      return;
    }

    const lastSeenMs = Date.parse(lastSeen);
    if (Number.isNaN(lastSeenMs) || nowMs - lastSeenMs >= KV_WRITE_THROTTLE_MS) {
      await env.CONNECTIONS.put(key, now.toISOString());
      connWriteMemo.set(key, nowMs);
    } else {
      // Another colo/isolate wrote recently — memoize *its* timestamp so the
      // next polls here skip the read too.
      connWriteMemo.set(key, lastSeenMs);
    }
  } catch {
    // Telemetry must never break the read path.
  }
}

// Server-side PostHog capture. distinct_id = sdk_key is merged into the
// owning user by the dashboard's posthog.alias(sdkKey) call on key copy.
async function captureFirstFetch(env: Env, request: Request, sdkKey: string, now: Date): Promise<void> {
  if (!env.POSTHOG_API_KEY) return;
  try {
    await fetch(`${env.POSTHOG_HOST}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_API_KEY,
        event: "sdk_first_fetch",
        distinct_id: sdkKey,
        timestamp: now.toISOString(),
        properties: {
          sdk_key: sdkKey,
          colo: request.cf?.colo ?? null,
          country: request.cf?.country ?? null,
          user_agent: request.headers.get("User-Agent") ?? null,
        },
      }),
    });
  } catch {
    // Lost capture is acceptable; the caller's KV write still records liveness.
  }
}

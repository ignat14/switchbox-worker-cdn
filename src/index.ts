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

    const body = await object.text();
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
    const lastSeen = await env.CONNECTIONS.get(key);
    const now = new Date();

    if (lastSeen === null) {
      // First fetch ever for this key → activation signal. A rotated key
      // re-fires this; harmless — both keys alias to the same PostHog person.
      await captureFirstFetch(env, request, sdkKey, now);
      await env.CONNECTIONS.put(key, now.toISOString());
      return;
    }

    const lastSeenMs = Date.parse(lastSeen);
    if (Number.isNaN(lastSeenMs) || now.getTime() - lastSeenMs >= KV_WRITE_THROTTLE_MS) {
      await env.CONNECTIONS.put(key, now.toISOString());
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

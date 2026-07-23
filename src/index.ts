interface Env {
  CONFIGS: R2Bucket;
  CONNECTIONS: KVNamespace;
  SDK_ANALYTICS?: AnalyticsEngineDataset;
  // Anonymous per-flag evaluation counts (MEASUREMENT Phase 1 / ADR-055).
  FLAG_ANALYTICS?: AnalyticsEngineDataset;
  POSTHOG_HOST: string;
  POSTHOG_API_KEY?: string;
  // First-telemetry activation ping → the backend (MEASUREMENT Phase 1). Both
  // unset (local/CI) → the ping is skipped; the shared secret gates the endpoint.
  BACKEND_URL?: string;
  TELEMETRY_SEEN_SECRET?: string;
}

// sdk_key is secrets.token_urlsafe(32) → ~43 chars of [A-Za-z0-9_-].
// Wide bounds so key-format changes don't 404 the read path.
const PATH_RE = /^\/([A-Za-z0-9_-]{16,128})\/flags\.json$/;
// Telemetry ingest route: POST /{sdk_key}/telemetry (MEASUREMENT Phase 1).
const TELEMETRY_RE = /^\/([A-Za-z0-9_-]{16,128})\/telemetry$/;

// --- Telemetry ingest guards (all fail-open; telemetry is best-effort) ---
// Per-request AE-write ceilings bound the cost of any single POST regardless of
// what a client (or an abuser) sends; the SDK caps values per flag at ~11, so
// real payloads never approach these. Extras are silently dropped.
const TELEMETRY_MAX_DATAPOINTS = 200;
const TELEMETRY_MAX_VALUES_PER_FLAG = 20;
const TELEMETRY_MAX_BODY_BYTES = 64 * 1024;
// Basic in-isolate anti-abuse rate limit, per sdk_key per fixed 60s window.
// Generous (a legit fleet sharing one key in one colo stays well under it); a
// runaway sender is capped. Per-isolate/best-effort, like the conn-write memo —
// an over-limit key just gets its telemetry sampled, which is acceptable.
const TELEMETRY_RATE_WINDOW_MS = 60 * 1000;
const TELEMETRY_RATE_MAX = 600;
const telemetryRate = new Map<string, { windowStart: number; count: number }>();
const TELEMETRY_RATE_MAP_MAX = 10_000;

// In-isolate memo of sdk_keys we've already sent a first-telemetry ping for, so
// the backend gets ~one ping per isolate ever (not per flush). The backend's
// UPDATE ... WHERE first_seen_at IS NULL is the exact fire-once dedup, so the
// worst case of a few pings across isolates/colos is idempotent there.
const firstSeenMemo = new Set<string>();
const FIRST_SEEN_MEMO_MAX = 10_000;

// In-isolate memo of sdk_keys confirmed to have a config in R2. The telemetry
// ingest gates on this (mirroring the read path's "unknown key → 404") so a
// forged/rotated key can't drive AE writes *or* backend activation pings — the
// rate limiter alone can't stop that, since an attacker varies the very key it's
// keyed on. Only HITS are memoized; misses re-check R2 (cheap, and never touch
// Neon), so the amplification is bounded to R2 class-B ops, not DB writes.
const configExistsMemo = new Set<string>();
const CONFIG_EXISTS_MEMO_MAX = 10_000;

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
  telemetryRate.clear();
  firstSeenMemo.clear();
  configExistsMemo.clear();
}

// The browser SDK fetches cross-origin; the R2 custom domain allowed this
// before the cutover, so the Worker must keep doing it.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    const url = new URL(request.url);

    // Telemetry ingest (MEASUREMENT Phase 1 / ADR-055): anonymous per-flag
    // evaluation counts → the switchbox_flag_evals AE dataset. Separate from
    // the flags.json read path; wholly fail-open.
    const telemetryMatch = TELEMETRY_RE.exec(url.pathname);
    if (telemetryMatch) {
      if (request.method !== "POST") {
        return jsonResponse(405, { error: "method_not_allowed" });
      }
      return handleTelemetry(env, request, ctx, telemetryMatch[1]);
    }

    if (request.method !== "GET") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

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
        // Browser-side caching only — no edge cache in front of the Worker, so
        // every poll is observed. Matched to the 10s SDK poll (MEASUREMENT
        // Phase 0): a longer max-age would let the browser HTTP cache serve a
        // stale config (and skip the Worker → poll unobserved) for up to that
        // window, defeating the faster propagation and the read-path telemetry.
        "Cache-Control": "public, max-age=10",
        ...CORS_HEADERS,
      },
    });
  },
};

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// Does this sdk_key have a published config? Memoizes hits in-isolate; misses
// re-check R2 (a cheap class-B `.head`, never Neon). Fail-closed on an R2 error
// (drop the telemetry) — best-effort, and it keeps the forged-key bound intact
// even during an R2 blip.
async function configKeyExists(env: Env, sdkKey: string): Promise<boolean> {
  if (configExistsMemo.has(sdkKey)) return true;
  try {
    const head = await env.CONFIGS.head(`${sdkKey}/flags.json`);
    if (!head) return false;
    if (configExistsMemo.size > CONFIG_EXISTS_MEMO_MAX) configExistsMemo.clear();
    configExistsMemo.add(sdkKey);
    return true;
  } catch {
    return false;
  }
}

// Fixed-window, in-isolate, per-key rate limit. Best-effort anti-abuse; an
// over-limit key's telemetry is dropped (fail-open — telemetry is not the read
// path). Returns true when the request should be rejected.
function isTelemetryRateLimited(sdkKey: string): boolean {
  const now = Date.now();
  const entry = telemetryRate.get(sdkKey);
  if (!entry || now - entry.windowStart >= TELEMETRY_RATE_WINDOW_MS) {
    if (telemetryRate.size > TELEMETRY_RATE_MAP_MAX) telemetryRate.clear();
    telemetryRate.set(sdkKey, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > TELEMETRY_RATE_MAX;
}

// Ingest one anonymous telemetry summary → one AE data point per (flag, value).
// The env key (in the path) is the only identifier: no identity, no context.
// Every failure mode returns a controlled JSON response with CORS; a bad AE
// write is swallowed. Row shape (dataset switchbox_flag_evals):
//   index1  = sdk_key
//   blob1   = flag_key   blob2 = value_repr   blob3 = sdk_name   blob4 = sdk_version
//   double1 = count (evaluations of that (flag,value) in the client's ~60s window)
async function handleTelemetry(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
  sdkKey: string,
): Promise<Response> {
  if (isTelemetryRateLimited(sdkKey)) {
    return jsonResponse(429, { error: "rate_limited" });
  }

  // Reject telemetry for keys with no published config (mirrors the read path's
  // unknown-key 404), BEFORE parsing the body or writing anything. This is the
  // real bound on forged/rotated keys — the per-key rate limit above can't stop
  // an attacker who varies the key. Fail-closed: if R2 can't confirm the key we
  // drop the telemetry (best-effort anyway) rather than risk the amplification.
  if (!(await configKeyExists(env, sdkKey))) {
    return jsonResponse(404, { error: "unknown_sdk_key" });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > TELEMETRY_MAX_BODY_BYTES) {
    return jsonResponse(413, { error: "payload_too_large" });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const body = payload as Record<string, unknown> | null;
  const flags = body?.flags;
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    return jsonResponse(400, { error: "invalid_payload" });
  }

  const sdkName = truncate(String(body?.sdk_name ?? ""), 64);
  const sdkVersion = truncate(String(body?.sdk_version ?? ""), 32);

  let written = 0;
  for (const [flagKey, values] of Object.entries(flags as Record<string, unknown>)) {
    if (written >= TELEMETRY_MAX_DATAPOINTS) break;
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    const fk = truncate(String(flagKey), 128);
    let perFlag = 0;
    for (const [valueRepr, count] of Object.entries(values as Record<string, unknown>)) {
      if (written >= TELEMETRY_MAX_DATAPOINTS || perFlag >= TELEMETRY_MAX_VALUES_PER_FLAG) break;
      const n = Number(count);
      if (!Number.isFinite(n) || n <= 0) continue;
      try {
        env.FLAG_ANALYTICS?.writeDataPoint({
          indexes: [sdkKey],
          blobs: [fk, truncate(String(valueRepr), 256), sdkName, sdkVersion],
          doubles: [n],
        });
      } catch {
        // Telemetry must never surface — drop this point.
      }
      written += 1;
      perFlag += 1;
    }
  }

  // First-telemetry activation: fire-and-forget a one-time ping to the backend
  // (re-homes sdk_first_fetch off KV absence — MEASUREMENT Phase 1). Memoized
  // per isolate so it's ~one ping ever, and the backend dedups exactly on the
  // first_seen_at NULL→now() transition, so an occasional extra ping is a no-op.
  pingFirstSeen(env, ctx, sdkKey);

  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function pingFirstSeen(env: Env, ctx: ExecutionContext, sdkKey: string): void {
  if (!env.BACKEND_URL || !env.TELEMETRY_SEEN_SECRET) return;
  if (firstSeenMemo.has(sdkKey)) return;
  if (firstSeenMemo.size > FIRST_SEEN_MEMO_MAX) firstSeenMemo.clear();
  // Memoize before the call: at-most-once per isolate even if the ping fails
  // (the backend is idempotent, and other isolates still ping). Fail-open.
  firstSeenMemo.add(sdkKey);
  ctx.waitUntil(
    fetch(`${env.BACKEND_URL}/internal/telemetry-seen`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telemetry-Secret": env.TELEMETRY_SEEN_SECRET,
      },
      body: JSON.stringify({ sdk_key: sdkKey }),
    }).catch(() => {
      // Activation is best-effort analytics — never surface.
    }),
  );
}

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

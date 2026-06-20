import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./index";

// ~43-char opaque sdk key, matching the production format.
const KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF-_";

interface MockOpts {
  /** R2 .get behavior: an object body, null (missing), or "throw". */
  r2?: { body: string; size?: number } | null | "throw";
  /** KV .get behavior: a stored value, null (first fetch), or "throw". */
  kvGet?: string | null | "throw";
  /** Make Analytics Engine writeDataPoint throw. */
  aeThrows?: boolean;
  posthogApiKey?: string;
}

function makeEnv(opts: MockOpts) {
  const { r2 = { body: '{"version":"v1","flags":{}}' }, kvGet = "ts", aeThrows, posthogApiKey } = opts;
  return {
    CONFIGS: {
      get: vi.fn(async () => {
        if (r2 === "throw") throw new Error("R2 down");
        if (r2 === null) return null;
        return { text: async () => r2.body, size: r2.size ?? r2.body.length };
      }),
    },
    CONNECTIONS: {
      get: vi.fn(async () => {
        if (kvGet === "throw") throw new Error("KV down");
        return kvGet;
      }),
      put: vi.fn(async () => {}),
    },
    SDK_ANALYTICS: {
      writeDataPoint: vi.fn(() => {
        if (aeThrows) throw new Error("AE down");
      }),
    },
    POSTHOG_HOST: "https://posthog.test",
    POSTHOG_API_KEY: posthogApiKey,
  };
}

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => promises.push(p), passThroughOnException: () => {} },
    settle: () => Promise.allSettled(promises),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(env: any, ctx: any, path = `/${KEY}/flags.json`, method = "GET") {
  return worker.fetch(new Request(`https://cdn.switchbox.dev${path}`, { method }), env, ctx);
}

describe("CDN worker — routing", () => {
  it("204 + CORS on OPTIONS preflight", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({}), ctx, `/${KEY}/flags.json`, "OPTIONS");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("405 on non-GET methods", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({}), ctx, `/${KEY}/flags.json`, "POST");
    expect(res.status).toBe(405);
  });

  it("404 on a path that isn't /{key}/flags.json", async () => {
    const { ctx } = makeCtx();
    expect((await call(makeEnv({}), ctx, "/nope")).status).toBe(404);
    expect((await call(makeEnv({}), ctx, "/short/flags.json")).status).toBe(404);
  });

  it("404 when the key is unknown (R2 miss)", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({ r2: null }), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_sdk_key");
  });
});

describe("CDN worker — serving", () => {
  it("200 with the config body, CORS, and a 30s browser cache", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({ r2: { body: '{"version":"v9","flags":{}}' } }), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"version":"v9","flags":{}}');
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("CDN worker — fail-open contract (R2 is the only hard dependency)", () => {
  it("500 only when the R2 read itself throws", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({ r2: "throw" }), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("config_unavailable");
  });

  it("still 200 when KV (liveness) throws", async () => {
    const { ctx, settle } = makeCtx();
    const res = await call(makeEnv({ kvGet: "throw" }), ctx);
    expect(res.status).toBe(200);
    // The waitUntil work must not reject the read path.
    await expect(settle()).resolves.toBeDefined();
  });

  it("still 200 when Analytics Engine throws", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({ aeThrows: true }), ctx);
    expect(res.status).toBe(200);
  });

  it("still 200 when the PostHog first-fetch capture throws", async () => {
    // First fetch (KV miss) + a configured PostHog key → captureFirstFetch runs
    // and calls global fetch; make that throw.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("posthog down"));
    try {
      const { ctx, settle } = makeCtx();
      const res = await call(makeEnv({ kvGet: null, posthogApiKey: "phc_test" }), ctx);
      expect(res.status).toBe(200);
      await expect(settle()).resolves.toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("CDN worker — telemetry wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the request and tracks liveness on a 200", async () => {
    const env = makeEnv({});
    const { ctx, settle } = makeCtx();
    await call(env, ctx);
    await settle();
    expect(env.SDK_ANALYTICS.writeDataPoint).toHaveBeenCalledOnce();
    expect(env.CONNECTIONS.get).toHaveBeenCalledWith(`conn:${KEY}`);
  });
});

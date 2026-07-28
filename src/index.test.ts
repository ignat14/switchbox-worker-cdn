import { describe, it, expect, vi, beforeEach } from "vitest";
import worker, { _resetForTests } from "./index";

// ~43-char opaque sdk key, matching the production format.
const KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF-_";

// Isolate-local state (rate limiter, first-seen + config-exists memos) must
// not leak across tests.
beforeEach(() => _resetForTests());

interface MockOpts {
  /** R2 .get behavior: an object body, null (missing), or "throw". */
  r2?: { body: string; size?: number } | null | "throw";
  /** Make the R2 object's .text() body read reject mid-stream. */
  bodyThrows?: boolean;
  /** Make Analytics Engine writeDataPoint throw. */
  aeThrows?: boolean;
}

function makeEnv(opts: MockOpts) {
  const { r2 = { body: '{"version":"v1","flags":{}}' }, bodyThrows, aeThrows } = opts;
  return {
    CONFIGS: {
      get: vi.fn(async () => {
        if (r2 === "throw") throw new Error("R2 down");
        if (r2 === null) return null;
        return {
          text: async () => {
            if (bodyThrows) throw new Error("body stream failed");
            return r2.body;
          },
          size: r2.size ?? r2.body.length,
        };
      }),
      // Telemetry ingest gates on key existence via .head (MEASUREMENT Phase 1).
      head: vi.fn(async () => {
        if (r2 === "throw") throw new Error("R2 down");
        if (r2 === null) return null;
        return { size: r2.size ?? r2.body.length };
      }),
    },
    SDK_ANALYTICS: {
      writeDataPoint: vi.fn(() => {
        if (aeThrows) throw new Error("AE down");
      }),
    },
    FLAG_ANALYTICS: {
      writeDataPoint: vi.fn(() => {
        if (aeThrows) throw new Error("AE down");
      }),
    },
  };
}

function postTelemetry(env: any, ctx: any, key = KEY, body?: unknown, init: RequestInit = {}) {
  return worker.fetch(
    new Request(`https://cdn.switchbox.dev/${key}/telemetry`, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      ...init,
    }),
    env,
    ctx,
  );
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

  it("405 on non-GET methods to the read path", async () => {
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
  it("200 with the config body, CORS, and a 10s browser cache", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({ r2: { body: '{"version":"v9","flags":{}}' } }), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"version":"v9","flags":{}}');
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=10");
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

  it("a failed R2 BODY read is a controlled 500 with CORS + telemetry, not a 1101 (FABLE 4.1)", async () => {
    const env = makeEnv({ bodyThrows: true });
    const { ctx } = makeCtx();
    const res = await call(env, ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("config_unavailable");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // The telemetry row still records the failure.
    expect(env.SDK_ANALYTICS.writeDataPoint).toHaveBeenCalledOnce();
  });

  it("still 200 when Analytics Engine throws", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({ aeThrows: true }), ctx);
    expect(res.status).toBe(200);
  });
});

describe("CDN worker — telemetry wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the request on a 200", async () => {
    const env = makeEnv({});
    const { ctx, settle } = makeCtx();
    await call(env, ctx);
    await settle();
    expect(env.SDK_ANALYTICS.writeDataPoint).toHaveBeenCalledOnce();
  });
});

describe("CDN worker — telemetry ingest (MEASUREMENT Phase 1)", () => {
  const summary = {
    sdk_name: "switchbox-python",
    sdk_version: "0.6.0",
    flags: { checkout_flow: { true: 3900, false: 301 }, hero: { '"A"': 12 } },
  };

  it("writes one FLAG_ANALYTICS row per (flag, value) and 204s", async () => {
    const env = makeEnv({});
    const { ctx } = makeCtx();
    const res = await postTelemetry(env, ctx, KEY, summary);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(env.FLAG_ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(3);
    expect(env.FLAG_ANALYTICS.writeDataPoint).toHaveBeenCalledWith({
      indexes: [KEY],
      blobs: ["checkout_flow", "true", "switchbox-python", "0.6.0"],
      doubles: [3900],
    });
    // The read-path dataset is untouched by telemetry ingest.
    expect(env.SDK_ANALYTICS.writeDataPoint).not.toHaveBeenCalled();
  });

  it("404s an unknown key WITHOUT writing AE rows, parsing, or pinging (forged-key bound)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const env = {
        ...makeEnv({ r2: null }), // no published config for this key
        BACKEND_URL: "https://backend.test",
        TELEMETRY_SEEN_SECRET: "s3cret",
      };
      const { ctx, settle } = makeCtx();
      const res = await postTelemetry(env, ctx, "forged-key-abcdefghij", summary);
      await settle();
      expect(res.status).toBe(404);
      expect(env.FLAG_ANALYTICS.writeDataPoint).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled(); // no backend ping for a fake key
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("400 on invalid JSON / missing flags", async () => {
    const { ctx } = makeCtx();
    const bad = await worker.fetch(
      new Request(`https://cdn.switchbox.dev/${KEY}/telemetry`, {
        method: "POST",
        body: "not json",
      }),
      makeEnv({}),
      ctx,
    );
    expect(bad.status).toBe(400);
    const noFlags = await postTelemetry(makeEnv({}), makeCtx().ctx, KEY, { sdk_name: "x" });
    expect(noFlags.status).toBe(400);
  });

  it("405 on GET to the telemetry route", async () => {
    const { ctx } = makeCtx();
    const res = await call(makeEnv({}), ctx, `/${KEY}/telemetry`, "GET");
    expect(res.status).toBe(405);
  });

  it("ignores non-positive / non-finite counts and malformed value maps", async () => {
    const env = makeEnv({});
    const { ctx } = makeCtx();
    await postTelemetry(env, ctx, KEY, {
      flags: { f: { good: 5, zero: 0, neg: -3, nan: "x" }, bad: "not-an-object" },
    });
    expect(env.FLAG_ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(env.FLAG_ANALYTICS.writeDataPoint).toHaveBeenCalledWith({
      indexes: [KEY],
      blobs: ["f", "good", "", ""],
      doubles: [5],
    });
  });

  it("is fail-open: a throwing FLAG_ANALYTICS write still 204s", async () => {
    const env = makeEnv({ aeThrows: true });
    const { ctx } = makeCtx();
    const res = await postTelemetry(env, ctx, KEY, summary);
    expect(res.status).toBe(204);
  });

  it("caps values per flag (extras dropped)", async () => {
    const values: Record<string, number> = {};
    for (let i = 0; i < 40; i++) values[`v${i}`] = 1;
    const env = makeEnv({});
    const { ctx } = makeCtx();
    await postTelemetry(env, ctx, KEY, { flags: { f: values } });
    // TELEMETRY_MAX_VALUES_PER_FLAG = 20
    expect(env.FLAG_ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(20);
  });

  it("fires a first-seen ping to the backend once per isolate (memoized)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const env = {
        ...makeEnv({}),
        BACKEND_URL: "https://backend.test",
        TELEMETRY_SEEN_SECRET: "s3cret",
      };
      const first = makeCtx();
      await postTelemetry(env, first.ctx, KEY, { flags: { f: { true: 1 } } });
      await first.settle();
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://backend.test/internal/telemetry-seen");
      expect((init!.headers as Record<string, string>)["X-Telemetry-Secret"]).toBe("s3cret");
      expect(JSON.parse(init!.body as string)).toEqual({ sdk_key: KEY });

      // Second POST for the same key in the same isolate → no second ping.
      const second = makeCtx();
      await postTelemetry(env, second.ctx, KEY, { flags: { f: { true: 1 } } });
      await second.settle();
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("skips the first-seen ping when the backend ping isn't configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const { ctx, settle } = makeCtx();
      await postTelemetry(makeEnv({}), ctx, KEY, { flags: { f: { true: 1 } } });
      await settle();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rate-limits a runaway sender (429) after the per-window ceiling", async () => {
    const env = makeEnv({});
    // TELEMETRY_RATE_MAX = 600 per key per window; 601st is rejected.
    let last: Response | undefined;
    for (let i = 0; i < 601; i++) {
      last = await postTelemetry(env, makeCtx().ctx, KEY, { flags: { f: { true: 1 } } });
    }
    expect(last!.status).toBe(429);
  });
});

# switchbox-worker-cdn

Cloudflare Worker that serves `GET /{sdk_key}/flags.json` on `cdn.switchbox.dev`
from the `switchbox-configs` R2 bucket (via binding — no S3 creds), replacing the
bare R2 custom domain. On each request it records read-path telemetry without
touching the zero-dependency SDKs:

1. **Analytics Engine** row per request (`switchbox_sdk_requests` dataset) —
   indexed by `sdk_key`; blobs: status, colo, country, user agent, config version.
   Since ADR-059 this dataset also backs the dashboard "Connected" badge (the
   backend reads `MAX(timestamp)` per key via the AE SQL API); the former KV
   liveness store and the KV-absence `sdk_first_fetch` capture are retired —
   activation is fired by the backend on the first telemetry ping instead.

It also accepts **`POST /{sdk_key}/telemetry`** (MEASUREMENT Phase 1 / ADR-054):
an anonymous per-flag evaluation summary the SDKs flush every ~60s. Each
`(flag, value)` becomes one row in the `switchbox_flag_evals` AE dataset
(`index = sdk_key`; blobs `flag_key, value_repr, sdk_name, sdk_version`; double
`count`). The env key in the path is the only identifier — no identity, no user
context. Per-request AE-write ceilings + a basic in-isolate per-key rate limit
bound cost; everything is fail-open (a bad write is dropped, the route still
204s). This is the value payoff of measurement (per-flag counts, value
distribution, per-flag liveness, stale-flag + outdated-SDK views). On a key's
first-ever telemetry the worker fire-and-forgets `POST /internal/telemetry-seen`
to the backend (shared secret), which sets `environments.first_seen_at` once and
fires the `sdk_first_fetch` activation event — the sole activation source since
the KV retirement (ADR-059).

**Fail open:** the R2 read is the only hard dependency. All telemetry runs in
`ctx.waitUntil()` / try-catch (or, for ingest, its own swallowed try-catch) — if
every signal write fails, flags are still served.

## Setup (one-time)

```bash
npm install
npx wrangler secret put TELEMETRY_SEEN_SECRET  # must match the backend's TELEMETRY_INGEST_SECRET
npx wrangler deploy                            # serves on workers.dev for testing
```

Verify on the workers.dev URL:

```bash
curl -i https://switchbox-worker-cdn.<account>.workers.dev/<sdk_key>/flags.json
```

Expect 200, `Cache-Control: public, max-age=10` (matched to the 10s SDK poll —
MEASUREMENT Phase 0), `Access-Control-Allow-Origin: *`; an unknown key returns a
404 JSON body.

## Cutover (done 2026-06-12) / rollback

The `routes` block in `wrangler.toml` puts this Worker in front of
`cdn.switchbox.dev/*` (it takes precedence over the R2 custom domain, which
stays attached to the bucket). **Rollback:** comment out the `routes` block and
redeploy — the R2 custom domain takes back over.

`sdk_first_fetch` is wired as step 5 of the **Activation** funnel in PostHog
(see `OBSERVABILITY.md` Phase 3); since ADR-059 the backend fires it (first
telemetry per environment), not this worker.

Setup gotcha: a Worker with an AE binding won't deploy (error 10089) until
Analytics Engine is enabled account-wide by creating the dataset in the
Cloudflare dashboard (Workers → Analytics Engine → Create Dataset). This applies
to **both** datasets — create `switchbox_flag_evals` (MEASUREMENT Phase 1)
alongside `switchbox_sdk_requests` before deploying the ingest route.

## Bindings & env

| Name | Kind | Notes |
|---|---|---|
| `CONFIGS` | R2 bucket | `switchbox-configs` |
| `SDK_ANALYTICS` | Analytics Engine | read-path polls — dataset `switchbox_sdk_requests`, 3-month retention; also the "Connected" badge source (ADR-059) |
| `FLAG_ANALYTICS` | Analytics Engine | per-flag eval counts — dataset `switchbox_flag_evals` (MEASUREMENT Phase 1) |
| `BACKEND_URL` | var | `https://switchbox-backend.fly.dev` — first-telemetry activation ping |
| `TELEMETRY_SEEN_SECRET` | secret | must match the backend's `TELEMETRY_INGEST_SECRET`; ping skipped when unset |

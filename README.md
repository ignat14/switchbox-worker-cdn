# switchbox-worker-cdn

Cloudflare Worker that serves `GET /{sdk_key}/flags.json` on `cdn.switchbox.dev`
from the `switchbox-configs` R2 bucket (via binding — no S3 creds), replacing the
bare R2 custom domain. On each request it records read-path telemetry without
touching the zero-dependency SDKs:

1. **Analytics Engine** row per request (`switchbox_sdk_requests` dataset) —
   indexed by `sdk_key`; blobs: status, colo, country, user agent, config version.
2. **KV liveness** — `conn:{sdk_key} = <ISO timestamp>`, throttled to one write
   per 5 minutes per key (KV free tier: 1k writes/day). Powers the dashboard
   "Connected" badge (Phase 4).
3. **First-fetch activation** — if the KV key was absent, fires a server-side
   `sdk_first_fetch` PostHog event with `distinct_id = sdk_key` (merged into the
   owning user via the dashboard's `posthog.alias(sdkKey)` on key copy).

It also accepts **`POST /{sdk_key}/telemetry`** (MEASUREMENT Phase 1 / ADR-054):
an anonymous per-flag evaluation summary the SDKs flush every ~60s. Each
`(flag, value)` becomes one row in the `switchbox_flag_evals` AE dataset
(`index = sdk_key`; blobs `flag_key, value_repr, sdk_name, sdk_version`; double
`count`). The env key in the path is the only identifier — no identity, no user
context. Per-request AE-write ceilings + a basic in-isolate per-key rate limit
bound cost; everything is fail-open (a bad write is dropped, the route still
204s). This is the value payoff of measurement (per-flag counts, value
distribution, per-flag liveness, stale-flag + outdated-SDK views) and the path
by which KV liveness will eventually be retired (prove-first — not yet removed).

**Fail open:** the R2 read is the only hard dependency. All telemetry runs in
`ctx.waitUntil()` / try-catch (or, for ingest, its own swallowed try-catch) — if
every signal write fails, flags are still served.

## Setup (one-time)

```bash
npm install
npx wrangler kv namespace create CONNECTIONS   # paste the id into wrangler.toml
npx wrangler secret put POSTHOG_API_KEY        # same key as VITE_POSTHOG_KEY
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
(see `OBSERVABILITY.md` Phase 3).

Setup gotcha: a Worker with an AE binding won't deploy (error 10089) until
Analytics Engine is enabled account-wide by creating the dataset in the
Cloudflare dashboard (Workers → Analytics Engine → Create Dataset). This applies
to **both** datasets — create `switchbox_flag_evals` (MEASUREMENT Phase 1)
alongside `switchbox_sdk_requests` before deploying the ingest route.

## Bindings & env

| Name | Kind | Notes |
|---|---|---|
| `CONFIGS` | R2 bucket | `switchbox-configs` |
| `CONNECTIONS` | KV namespace | liveness keys `conn:{sdk_key}` |
| `SDK_ANALYTICS` | Analytics Engine | read-path polls — dataset `switchbox_sdk_requests`, 3-month retention |
| `FLAG_ANALYTICS` | Analytics Engine | per-flag eval counts — dataset `switchbox_flag_evals` (MEASUREMENT Phase 1) |
| `POSTHOG_HOST` | var | `https://eu.i.posthog.com` |
| `POSTHOG_API_KEY` | secret | public project key; `sdk_first_fetch` is skipped when unset |

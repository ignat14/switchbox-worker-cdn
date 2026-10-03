---
name: cloudflare-worker
description: >
  Conventions for the switchbox-worker-cdn Cloudflare Worker, which serves flags.json from R2
  and ingests anonymous flag telemetry. Use when modifying, deploying, or debugging it: routes,
  wrangler config, secrets, R2 / Analytics Engine bindings, CORS, conditional (ETag / 304)
  fetches, or the fail-open telemetry rules for the read path.
---

# cloudflare-worker

`switchbox-worker-cdn` serves `flags.json` from R2 and emits read-path telemetry. It sits in
every SDK's read path, so its rules are strict.

## Shared conventions

- **Single-file Worker:** all logic in `src/index.ts`; TypeScript; no framework and no router
  library. A regex/`if` match on `url.pathname` is enough at this scale.
- **Config split:** non-secrets in `wrangler.toml` `[vars]`; secrets via
  `npx wrangler secret put NAME` (never in the toml, never in git). Optional features are
  **disabled when their binding or secret is unset** (e.g. the backend ping is skipped without
  `BACKEND_URL` or `TELEMETRY_SEEN_SECRET`; analytics writes no-op without their dataset). Code
  must handle the missing-binding case, not crash.
- **CORS:** every response, including errors, 304s and preflights, carries
  `Access-Control-Allow-Origin: *` plus the shared `CORS_HEADERS` set. Browser SDKs fetch
  cross-origin, and the R2 custom domain did this before the Worker took over, so the Worker
  must keep parity.
- **Dev/deploy:** `npm run dev` (local). Deploys are GitHub Actions: a push to `main` that
  passes the test job runs `wrangler deploy` (repo secrets `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`), then a post-deploy smoke checks the live route. The real-config
  smoke step is gated on the `SMOKE_SDK_KEY` repo secret and fails the run when it is unset.
  Local `npx wrangler deploy` still works for emergencies and rollback. `npx wrangler tail`
  streams production logs when debugging.
- **Test before deploy:** Vitest (`npm test`) invokes the handler directly with a mock
  `env`/`ctx` and a stubbed global `fetch` (no Miniflare). CI runs `npm ci`, `npm run lint`
  (a `tsc --noEmit` type-check) and `npm test` on every push and PR, and they gate the
  auto-deploy. For a *local* emergency `wrangler deploy`, run `npm run lint` and `npm test`
  yourself first. The tests pin the **fail-open contract**: only an R2 read failure may
  return 500; Analytics Engine and backend-ping failures must still return 200. If you make
  any telemetry write load-bearing (awaited in the response path, able to fail the read),
  those tests will, and should, go red.

## Specifics (the read path, strictest rules)

Bindings (in `wrangler.toml`): `CONFIGS` (R2 bucket `switchbox-configs`), `SDK_ANALYTICS`
(Analytics Engine dataset `switchbox_sdk_requests`, one row per read request) and
`FLAG_ANALYTICS` (dataset `switchbox_flag_evals`, telemetry ingest), plus the `BACKEND_URL`
var and the `TELEMETRY_SEEN_SECRET` secret (the first-telemetry callback to the backend).

1. **Fail open: the only hard dependency is the R2 read.** Analytics Engine writes are
   non-blocking and wrapped in try/catch; the backend ping runs inside `ctx.waitUntil()` with
   a swallowed rejection. If all telemetry fails, `flags.json` is still served. Never `await`
   telemetry before responding. **No uncontrolled errors anywhere:** both the R2 `.get` and
   the body `.text()` read are wrapped, so a mid-stream body failure is a JSON 500 (`config_unavailable`)
   with CORS and a telemetry row, never a raw 1101 page the browser SDK can't read.
2. **Serve path:** `GET /{sdk_key}/flags.json` reads `{sdk_key}/flags.json` from `CONFIGS`;
   JSON-body 404 (`unknown_sdk_key`) if absent. Keep `Cache-Control: public, max-age=10`
   (matched to the SDK's 10s poll; a longer max-age lets the browser cache skip the Worker and
   leaves polls unobserved). Do NOT put an edge cache in front: every poll must be observed,
   and R2 binding reads are cheap.
3. **Conditional fetch (ETag / 304):**
   - Every 200 carries the R2 `ETag` (`httpEtag`) and `Access-Control-Expose-Headers: ETag`.
     Without the expose header a browser SDK can't read the ETag cross-origin, so it could
     never send `If-None-Match` back.
   - A matching `If-None-Match` returns an empty 304 with the same `ETag`, `Cache-Control`
     and CORS headers and no response body. Matching accepts `*`, comma-separated lists, and
     weak validators (`W/"…"`), because Cloudflare weakens a strong ETag when it compresses a
     response.
   - A 304 is still a poll: it writes its `SDK_ANALYTICS` row with status `"304"` and
     response bytes `0`. The config version comes from the R2 custom metadata key
     `config-version` (keep it in lockstep with the metadata key the backend publisher
     writes). Objects published before that metadata existed fall back to reading the body
     just to parse the version.
   - Any consumer of the request dataset must treat 200 and 304 as served, or instance counts
     and propagation views will undercount.
4. **Telemetry ingest (`POST /{sdk_key}/telemetry`):** gate on `configKeyExists` (R2 `.head`,
   fail-closed: an R2 error drops the telemetry) BEFORE parsing the body. That is the
   forged-key bound; the in-isolate per-key rate limit can't stop a client that varies the key.
   Per-request caps (body size, total datapoints, values per flag, string lengths) and the
   per-key rate limit bound cost. Extras are dropped, a failed write is dropped, and an
   accepted payload still returns 204. On a key's first ingest per isolate, fire-and-forget the
   `/internal/telemetry-seen` backend ping (memoize BEFORE the fetch; the backend dedups, so an
   occasional extra ping is harmless). An unknown key or R2 failure while validating the key
   must write no Analytics Engine rows and trigger no ping.
5. **Cutover/rollback:** the `cdn.switchbox.dev/*` route in `wrangler.toml` is the switch:
   commented out means the R2 custom domain serves; deployed with the route means the Worker
   serves. Test changes on the `workers.dev` URL before enabling the route. Rollback =
   comment the route out and redeploy, and **commit it**, or the next push to `main`
   auto-redeploys the committed route.
6. **Verify after deploy:** `curl -si https://cdn.switchbox.dev/{sdk_key}/flags.json` and
   check 200, the CORS headers, `ETag`, `Cache-Control`, and valid JSON. Then repeat with
   `-H 'If-None-Match: <etag>'` and expect an empty 304. Confirm the Analytics Engine row
   landed (dashboard usage panel or the AE SQL API) and that a telemetry POST returns 204.

## Gotchas

- `wrangler.toml` changes (new bindings, vars, routes) only take effect on deploy. Local
  `wrangler dev` reads them, but production lags until `wrangler deploy`.
- Workers have no Node APIs: Web standards only (`fetch`, `crypto.subtle`, `URL`). This
  matches the SDK constraint, so evaluator-style code is portable.

# Contributor guide

This repository contains the Cloudflare Worker for the Switchbox CDN. Keep changes small, preserve the public response contract, and update tests whenever behavior changes.

## Commands

Use Node.js 22, matching CI.

- Install exactly from the lockfile: `npm ci`
- Type-check: `npm run lint` (despite the script name, it currently runs `tsc --noEmit`; no separate linter is configured)
- Run the test suite once: `npm test`
- Build without deploying: `npx wrangler deploy --dry-run`
- Start local development: `npm run dev`
- Deploy, only when explicitly intended: `npm run deploy`

CI runs `npm ci`, `npm run lint`, and `npm test` for every pushed branch and pull request. A successful push to `main` also deploys and smoke-tests the live route; see `.github/workflows/deploy.yml`.

## Repository layout and conventions

- `src/index.ts` is the module Worker entry point and owns routing, R2 reads, CORS, caching, and telemetry.
- `src/index.test.ts` directly invokes the fetch handler with mocked bindings. Add focused Vitest coverage for routing, headers, failure modes, and telemetry changes, and reset isolate-local state between tests.
- `wrangler.toml` is the source of truth for the entry point, route, compatibility date, public variables, and Cloudflare bindings.
- `README.md` documents the externally visible behavior and deployment setup. Keep it aligned with contract changes.
- Keep TypeScript strict and use Worker/Web Platform APIs; do not assume a Node.js runtime in production.

## Response and CORS contract

- `GET /{sdk_key}/flags.json` reads `{sdk_key}/flags.json` from R2. A hit returns the stored JSON with `ETag`, `Cache-Control: public, max-age=10`, and CORS headers.
- A matching `If-None-Match` returns an empty `304` with the same ETag, cache, and CORS behavior. Preserve weak and comma-separated ETag matching.
- Unknown keys return JSON `404`; R2 read or body-stream failures return controlled JSON `500` responses. Do not expose an uncontrolled Worker error page.
- `POST /{sdk_key}/telemetry` accepts anonymous aggregate flag counts. Valid accepted payloads return `204`, including when an Analytics Engine write fails. Preserve the existing key-existence check, payload/write caps, truncation, and rate limit.
- Preflight requests return `204`. Controlled responses must preserve the shared CORS policy: any origin, `GET, POST, OPTIONS`, any request headers, a one-day preflight max age, and exposed `ETag`.

## Fail-open telemetry boundary

The R2 `CONFIGS` read is the only hard dependency for serving flags. Read-path analytics, flag-evaluation analytics, and the first-telemetry backend ping are best-effort: catch failures and never let them change a successful flag response. Keep backend pings in `ctx.waitUntil()` with a swallowed rejection.

Telemetry ingestion may reject malformed, oversized, rate-limited, or unknown-key requests with its existing controlled JSON responses. An R2 failure while validating a telemetry key must drop telemetry; it must not create Analytics Engine rows or trigger the backend ping.

## Cloudflare bindings

Use the public binding names already declared in `wrangler.toml` and typed in `src/index.ts`:

- `CONFIGS`: R2 bucket containing published configs; required for serving flags.
- `SDK_ANALYTICS`: Analytics Engine dataset for read-path requests; optional at runtime.
- `FLAG_ANALYTICS`: Analytics Engine dataset for aggregate flag evaluations; optional at runtime.
- `BACKEND_URL`: variable for the best-effort first-telemetry callback; optional.
- `TELEMETRY_SEEN_SECRET`: secret for that callback; optional and intentionally absent from source control.

Never commit secret values, local Wrangler state, credentials, private documentation links, or non-public operational details.

## Before handing off

Run `npm run lint`, `npm test`, and `npx wrangler deploy --dry-run`. Review `git diff` and confirm no generated output, credentials, or unrelated changes are included.

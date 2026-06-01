# LifeShot Edge Functions

7 resource functions under `supabase/functions/`:
`me`, `sources`, `catalog`, `search`, `organization`, `families`, `privacy`.

Each is a Hono app with internal routing. Shared middleware lives in
`_shared/`. Schemas + types live in `packages/core/api/`.

## Local dev

```bash
supabase functions serve --env-file .env.local
# Then hit:
curl -sS -H "Authorization: Bearer $JWT" \
  -X POST http://localhost:54321/functions/v1/catalog/memory/viewport \
  -d '{"viewport_size":60}' | jq
```

## Deploy

```bash
for fn in me sources catalog search organization families privacy; do
  supabase functions deploy "$fn" --project-ref vohevknnbvpaooletyts --no-verify-jwt
done
```
(`--no-verify-jwt` because each function's middleware verifies the JWT
itself; this lets `/sources/providers` and `/sources/callback` be public.)

## Generate OpenAPI

```bash
deno run -A scripts/gen-openapi.ts > docs/openapi.json
```

## Deviations from spec
- Cache / rate-limit / idempotency live in Postgres tables (`api_cache_entries`,
  `api_rate_limits`, `api_idempotency_keys`) instead of Redis — swap to
  Upstash by replacing `_shared/cache.ts` and `_shared/ratelimit.ts`.
- Observability is `console.log` JSON lines — wire PostHog/OTel/Sentry SDKs
  in `_shared/observability.ts` when those connectors land.
- JobEnqueuer/QueryParser/Embedder are mocks in `_shared/interfaces.ts` per spec.
- Token exchange in `/sources/callback` stores a stub; real OAuth swap is the
  connector prompt.

# Lifeshot Worker

Single Edge Function (`worker`) that drains the `job_queue` table populated by
the API layer. Driven by `pg_cron` every 10 seconds via `app.worker_base_url`
(set this in Supabase project settings to the worker's public URL) and an
`x-worker-secret` header verified against `WORKER_SECRET`.

## Endpoints

- `POST /drain`           — drain until empty (max 7s wall clock).
- `POST /drain/once`      — claim+process one batch (for tests).
- `POST /drain/sync`      — long synchronous drain (used by integration tests).
- `POST /cron/incremental-sync`  — enqueue `syncSource` for every connected account.
- `POST /cron/dead-letter-sweep` — report DLQ size + sweep stuck `running` jobs.
- `POST /enqueue/:name`   — admin enqueue (requires `x-worker-secret`).

## Local fixture pipeline

```bash
deno test -A supabase/functions/_tests/pipeline.test.ts
deno test -A supabase/functions/_tests/connectors.test.ts
```

All AI / OCR / embedder / geocoder / renderer / email providers are deterministic
mocks by default. Swap implementations via `setProviders({ ... })` (see `_jobs/mocks.ts`).

## Configuration

| Env var | Purpose |
| --- | --- |
| `WORKER_SECRET`              | shared with pg_cron via `app.worker_secret` |
| `SUPABASE_URL`               | service client |
| `SUPABASE_SERVICE_ROLE_KEY`  | service client |
| `GOOGLE_CLIENT_ID/SECRET`    | Google Photos OAuth refresh |
| `APP_BASE_URL`               | used in invitation email URLs |

`pg_cron` schedules (created by migration 20260530172614):
- `lifeshot_drain`           — `*/10 * * * * *`
- `lifeshot_incremental_sync`— `*/15 * * * *`
- `lifeshot_stuck_sweep`     — `*/5 * * * *`
- `lifeshot_dead_letter_sweep` — `0 */6 * * *`
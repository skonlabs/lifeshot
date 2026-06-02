
# Plan — Rewrite Metadata Extraction & Indexing

## Why the current system fails

The sub-agent's audit confirmed three concrete failure modes:

1. **Three competing drain mechanisms** (in-process `waitUntil`, HTTP nudge to `/worker/drain`, pg_cron) all need URL/secret config that's only seeded *after* the first sync — so the first sync nothing drains it.
2. **`/worker/drain` has a 7s budget** but a single Dropbox `list_folder` call can take 20s → worker times out mid-job and leaves rows in `running` forever.
3. **`countSelectionStats()` runs a full recursive Dropbox crawl on every `/v1/accounts` request** — blocks the UI even when sync is fine.

The architecture is over-engineered (3 drain paths, idempotency ledger, lane scheduling, dynamic system_config URL) for what is conceptually a job queue + worker.

## New architecture (one mental model)

```text
[Sync button]
     │ POST /sources/:id/sync
     ▼
┌─────────────────────────┐
│ enqueue ONE job:        │   instantly returns 202
│  syncSource(account,    │   sets source_sync_jobs.stats.stage="queued"
│   cursor=null)          │
└──────────┬──────────────┘
           │
   pg_cron every 30s ────────────► POST /worker/drain   (hard-coded URL via Vault)
           │                          │
           ▼                          ▼
   ┌──────────────────────────────────────────┐
   │ drainOnce() loop, 50s budget per call    │
   │  claim 1 job → run → complete            │
   └──────────────┬───────────────────────────┘
                  ▼
       ┌──────────────────────┐
       │ syncSource(page):    │
       │  • list ONE page     │  (≤ 500 files, ≤ 25s)
       │  • upsert assets     │
       │  • write stats       │  stage, discovered, indexed
       │  • enqueue per-asset │  → normalizeMetadata jobs
       │  • if nextCursor:    │
       │      enqueue self    │
       │  • else:             │
       │      mark complete   │
       └──────────────────────┘
                  ▼
   normalizeMetadata → hashAsset → indexSearchDocument
   (each one its own queue job; pipeline already exists)
```

**Single drain path. No `waitUntil`. No in-process drain. No HTTP nudge from inside jobs.** Just `pg_cron → /worker/drain → claim → run → return`.

## What the user sees in the UI

1. Click **Sync** → toast "Sync queued" → row shows **Queued** (~0–30s while cron waits).
2. Worker picks it up → row shows **Listing files… (N discovered)** with a counter that increases every page (≈ every 5–15s for Dropbox).
3. As assets are inserted, **Indexing files… (X / N)** with an indexed counter.
4. When `nextCursor=null`, status flips to **Sync complete** and `source_accounts.last_synced_at` is set.
5. Background enrichment (hash, thumbnails, EXIF, AI, search index) continues silently; the asset count on /library grows in real time.

Failure modes are visible: any job that hits `max_attempts` shows a red **Error** badge with the message from `source_errors`.

## What changes

### Removed / simplified
- Delete the in-process `EdgeRuntime.waitUntil(drainUntilEmpty(...))` in `sources/index.ts`.
- Delete the inline `kickWorkerDrain({ inline: true })` calls inside `syncSource.ts`.
- Delete the `system_config`-based dynamic worker URL. Use a single env var `WORKER_URL` set by the cron migration.
- Delete `countSelectionStats()` from the hot `/v1/accounts` path; replace with a cached count read from `source_sync_jobs.stats.discovered` (last completed).
- Remove the dual `list` / `delta` cursor kinds for now — single cursor per account.

### Rewritten

**`supabase/functions/_jobs/syncSource.ts`** — one page per invocation, no chaining tricks:
```ts
// Pseudo:
1. set stats.stage="listing", touch heartbeat
2. cursor = load(source_sync_cursors)
3. page = await connector.listPage(cursor)   // ≤ 500 items, ≤ 25s
4. upsert assets + asset_source_refs in ONE transaction
5. enqueueMany("normalizeMetadata", newIds)
6. save new cursor
7. stats.discovered += page.length; stats.indexed = count(asset_source_refs)
8. if page.nextCursor: enqueue("syncSource", {...same payload, cursor: page.nextCursor})
   else: source_accounts.status="active", stats.stage="completed"
```

**`supabase/functions/_sources/*.ts`** — each connector exposes ONE method:
```ts
listPage(cursor: unknown | null, opts: { pageSize: 500, signal: AbortSignal })
  : Promise<{ items: ProviderAsset[]; nextCursor: unknown | null }>
```
- Dropbox: non-recursive BFS, pendingPaths stored in cursor (already there, keep).
- Google Photos: `mediaItems:search` with pageToken.
- OneDrive: `/drive/items/{id}/children` with `@odata.nextLink`.
- Local: client-side scan already works; server `listPage` is a no-op that consumes a client-uploaded manifest.

Hard 25s timeout per provider call via `AbortController`.

**`supabase/functions/worker/index.ts`** — simplify `/drain`:
- 50s budget (Edge Functions allow 60s)
- `batch: 4` concurrent jobs
- always 200 OK with a JSON summary `{ claimed, completed, failed, elapsedMs }`
- single secret check via `Authorization: Bearer ${WORKER_SECRET}`

**`supabase/functions/sources/index.ts`** — `POST /v1/:id/sync`:
- enqueue one job, write `source_sync_jobs` row with `stats={stage:"queued",discovered:0,indexed:0}`
- return 202 immediately, no drain calls
- `GET /v1/:id/status` reads only `source_sync_jobs` (latest by id) + `asset_source_refs` count

**`src/routes/_authenticated/sources.tsx`** — replace ambiguous "Discovering files…" with explicit stages from `stats.stage`: `queued | listing | indexing | completed | failed`. The string "Discovering files…" goes away entirely.

**`src/lib/realtime/useSourceProgress.ts`** — add subscription to `source_sync_jobs` so `stats` updates trigger cache invalidation (the current code only watches `source_accounts` and `job_queue`). Keep the 2s poll as fallback.

### New migration

`supabase/migrations/<ts>_simple_worker_cron.sql`:
- Drop existing `lifeshot_drain` cron + the `system_config`-based plumbing.
- Recreate cron every 30s using a hard-coded `https://<project-ref>.supabase.co/functions/v1/worker/drain` and a single Vault secret `worker_secret`.
- Add `claim_pending_jobs` / `complete_job` / `sweep_stuck_jobs` (review existing definitions; keep them — they're fine).
- Add an index `job_queue (status, next_attempt_at)` if missing.

## Technical details (for me, not the user)

- **No new tables.** Reuse `job_queue`, `source_sync_jobs`, `source_sync_cursors`, `asset_source_refs`, `assets`, `asset_metadata`, `asset_search_documents`.
- **Idempotency:** keep `job_ledger`, but only for the per-asset jobs (`hashAsset`, `indexSearchDocument`). `syncSource` is naturally idempotent via `asset_source_refs` unique constraint.
- **Scalability to 500K files:** each `syncSource` page is ≤25s and ≤500 items; 500K files = ≤1000 pages = ≤8 hours of background processing at 30s cron cadence. Per-asset enrichment runs in parallel (batch=4) → throughput ~4 assets/sec → 500K finishes in ~35 hours of background. That's acceptable; users see results streaming into /library throughout.
- **Cancellation:** `source_accounts.sync_cancel_requested_at` checked at the top of every `syncSource` invocation; if set, mark `stats.stage="cancelled"` and stop chaining.
- **All four connectors get the same `listPage` contract** so the worker doesn't care which provider it's syncing.

## Files touched

```
supabase/functions/sources/index.ts            (simplify sync POST + status GET, drop countSelectionStats from hot path)
supabase/functions/_jobs/syncSource.ts         (rewrite: one page per invocation)
supabase/functions/_sources/dropbox.ts         (keep BFS, expose listPage, add AbortController)
supabase/functions/_sources/google_photos.ts   (rewrite to listPage contract)
supabase/functions/_sources/onedrive.ts        (rewrite to listPage contract)
supabase/functions/_sources/local_ios.ts       (adapt to listPage no-op)
supabase/functions/_sources/registry.ts        (unified listPage interface)
supabase/functions/worker/index.ts             (simplify /drain, drop in-process kick logic)
supabase/functions/_pipeline/runner.ts         (no functional change; drop unused helpers)
src/routes/_authenticated/sources.tsx          (stage-driven labels, remove "Discovering files…")
src/lib/realtime/useSourceProgress.ts          (subscribe to source_sync_jobs)
src/lib/api/hooks.ts                           (no API surface change; verify polling logic)
supabase/migrations/<ts>_simple_worker_cron.sql (new — cron + secret + index)
```

## Out of scope (explicitly)

- AI vision, OCR, embeddings, face clustering — already working downstream of `normalizeMetadata`. Untouched.
- OAuth connect / disconnect flows. Untouched.
- Search query path (`search/index.ts`, hybrid search). Untouched.

## Verification after build

1. Click Sync on a Dropbox account → row shows "Queued" within 1s.
2. Within 30s, row shows "Listing files… (N)" with N increasing.
3. /library page asset count grows live.
4. Check `select status, count(*) from job_queue group by 1;` — pending count drops to 0 within minutes after sync completes.
5. Disconnect network during sync → row eventually shows "Failed: timeout" not infinite spinner.

---

**Approve this plan and I'll implement it in one pass, then explain step-by-step how the user experiences each phase.**

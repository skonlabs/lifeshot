# LifeShot Supabase Backend

Migrations are forward-only and ordered. Apply them to your own Supabase
project (this app does NOT use Lovable Cloud).

## Apply

Option A — Supabase CLI (recommended):
```bash
supabase link --project-ref vohevknnbvpaooletyts
supabase db push        # applies supabase/migrations in order
```

Option B — SQL editor: paste each file 0001…0014 in order.

## After applying

Generate typed DB client:
```bash
supabase gen types typescript --project-id vohevknnbvpaooletyts --schema public \
  > supabase/types/database.types.ts
```

## Open decisions (defaults baked in)

| Decision | Default | Revisit when |
| --- | --- | --- |
| Embedding model / dim | text-embedding-3-small / 1536 | switch to 3-large → migration to vector(3072) |
| Face vector dim | 512 | swap model |
| ANN index | hnsw (m=16, ef_construction=64), cosine | > ~1M vectors/user-set |
| FTS language | english + simple | multi-language users |
| Partitioning | partition-ready columns; not partitioned yet | Stage-4 scale |
| Face detections live on `asset_faces`; person aggregation lives on `people` | revisit only if face schema changes again |

## Test checklist (Definition of Done)

- `supabase db reset` applies 0001–0014 with zero errors
- RLS isolation: user A cannot read user B's assets / tokens / search docs / embeddings / audit logs
- `source_tokens` unreadable by `anon`/`authenticated`
- `deleted_state <> 'active'` never returned by `get_viewport` or `hybrid_search`
- `merge_assets` / `split_source_ref` reversible and audited
- `disconnect_source` / `delete_account` cascade and write audit completion
- `source_providers` seeded with the 11 providers
- `match_assets_by_embedding`, `hybrid_search`, `get_viewport`, `get_dashboard_counts`, `get_facets` return results on seed

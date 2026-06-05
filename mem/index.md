# Project Memory

## Core
User uses their OWN Supabase project (NOT Lovable Cloud). Project ref: vohevknnbvpaooletyts (lifeshot).
DB access is via Supabase Management API using SBP_ACCESS_TOKEN secret. NEVER say "no database access" and NEVER tell user to enable Lovable Cloud toggles.
Run SQL like:
  curl -s -X POST "https://api.supabase.com/v1/projects/vohevknnbvpaooletyts/database/query" \
    -H "Authorization: Bearer $SBP_ACCESS_TOKEN" -H "Content-Type: application/json" \
    -d '{"query":"<SQL>"}'
Use this to verify metadata rows, job_queue state, source_sync_jobs progress, etc. directly before claiming a fix works.

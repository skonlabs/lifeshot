# Project Memory

## Core
User has granted DB access via Lovable Cloud permissions. When PG* env vars are present, USE psql directly to verify DB state — never claim "no database access". If PGHOST is missing, the permission toggle ("Read database" / "Add data" → Always allow) needs flipping; state that specifically rather than saying credentials are missing.

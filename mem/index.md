# Project Memory

## Core
Backend: user manages their own Supabase project directly (NOT Lovable Cloud). Do not propose enabling Lovable Cloud. For backend/database requests, provide SQL/code the user can run in their own Supabase project.
Design: Palette #111111 ink, #D6B25E gold, #14B8A6 teal, #FAFAF7 bg, #1E293B text. Typography: Outfit (display) + Figtree (body).
Supabase access: credentials persisted in .lovable/secrets.local.env (gitignored). To run psql/migrations: `source .lovable/secrets.local.env && psql "$SUPABASE_DB_URL" -f <file>`. Project ref vohevknnbvpaooletyts. NEVER ask the user to paste these again, NEVER suggest running SQL themselves — apply migrations directly.

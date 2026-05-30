# LifeShot API — Example Requests & Responses

All endpoints under `https://<project>.supabase.co/functions/v1/<resource>/...`
Auth: `Authorization: Bearer <supabase user JWT>` on every authed call.

## POST /catalog/memory/viewport
Request:
```json
{"viewport_size": 60, "quality_preference": "balanced"}
```
Response 200:
```json
{
  "items": [{
    "asset_id": "8f...","thumbnail_url": "https://.../signed","blurhash": "L6Pj...",
    "dominant_color": "#3a4f6b","width": 4032,"height": 3024,
    "capture_time": "2024-08-12T19:22:00Z","media_type": "photo",
    "source_badge": "google_photos","hydration_status": "ready",
    "next_quality_url": null,"original_fetch_policy": "on_demand",
    "cache_status": "warm","prefetch_hint": false
  }],
  "next_cursor": "eyJiZWZvcmUiOiIyMDI0LTA4LTEyVDE5OjIyOjAwWiJ9",
  "cache": {"hit": false, "ttl_seconds": 30}
}
```

## POST /search
Request: `{"query": "beach trip 2023", "k": 30}`
Response 200:
```json
{
  "query_id": "...",
  "results": [{"asset_id":"...","score":0.84,"explanation":{"fts":0.6,"vector":0.31}, "...": "descriptor fields"}],
  "facets": {"by_year":{"2023":42}, "by_country":{"PT":18}},
  "parsed": {"intent":"filter","entities":{"dates":["2023"]},"filterPlan":{"from":"2023-01-01","to":"2023-12-31"}}
}
```

## POST /sources/connect
Request: `{"provider_id": "..."}`
Response 200: `{"authorize_url":"https://accounts.google.com/...&state=abc","session_token":null,"state":"abc"}`

## GET /sources/callback?code=...&state=...
Redirect 302 to `${APP_REDIRECT_URL}/connect/success?account=<uuid>`

## GET /catalog/dashboard
Response 200:
```json
{"total_assets":12842,"at_risk":311,"duplicate_groups":58,
 "per_year":{"2024":4012,"2023":3998},"per_source":{"google_photos":7012,"local_ios":4830},
 "cache":{"hit":true}}
```

## GET /organization/duplicates
Response 200: `{"groups":[{"id":"...","confidence":0.94,"recommended_primary_asset_id":"...","members":[...]}]}`

## POST /organization/duplicates/{id}/confirm
Request: `{"action":"keep_primary","primary_asset_id":"..."}`
Response 200: `{"ok":true,"action":"keep_primary"}`

## POST /privacy/export
Response 202: `{"job_id":"...","status":"accepted","preview":{...}}`

## DELETE /privacy/account
Request: `{"confirm": true}`
Response 202: `{"status":"completed","operation_id":"..."}`

## Errors
401: `{"error":{"code":"unauthorized","message":"Invalid or expired token","request_id":"..."}}`
422: `{"error":{"code":"validation_failed","message":"Invalid body","request_id":"...","details":{"issues":[...]}}}`
429: `{"error":{"code":"rate_limited","message":"Rate limit exceeded for search","request_id":"...","details":{"bucket":"search","limit":30,"window_seconds":60}}}`

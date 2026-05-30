import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseParams, parseQuery } from "../_shared/validation.ts";
import { sendError, ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { getServiceClient } from "../_shared/clients.ts";
import { jobEnqueuer } from "../_shared/interfaces.ts";
import { cache, keys, hashJson } from "../_shared/cache.ts";
import { findIdempotent, storeIdempotent } from "../_shared/idempotency.ts";
import { emitEvent } from "../_shared/observability.ts";
import { ENV } from "../_shared/env.ts";

const ConnectIn = z.object({
  provider_id: z.string().uuid(),
  redirect_uri: z.string().url().max(2048).optional(),
}).strict();

const app = createApi("/sources/v1");

// Providers list (public-ish: providers seeded reference data)
app.get("/providers", async (c) => {
  const cached = await cache.get<unknown>(c, keys.providers());
  if (cached) return c.json({ providers: cached, cache: { hit: true } });
  const s = getServiceClient();
  const { data, error } = await s.from("source_providers")
    .select("id, kind, name, priority, default_capabilities")
    .order("priority").order("name");
  if (error) throw new ApiError("internal", error.message);
  const providers = (data ?? []).map(p => ({
    id: p.id, kind: p.kind, name: p.name, priority: p.priority,
    capabilities: p.default_capabilities,
  }));
  await cache.set(c, keys.providers(), providers, 3600);
  return c.json({ providers, cache: { hit: false } });
});

// All routes below require auth
app.use("*", (await import("../_shared/auth.ts")).withAuth);

app.get("/accounts", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const { data, error } = await supa.from("source_accounts").select(`
    id, provider_id, display_label, status, connected_at, disconnected_at,
    provider:source_providers(kind)
  `).order("connected_at", { ascending: false });
  if (error) throw new ApiError("internal", error.message);
  // Counts per account (separate aggregate)
  const ids = (data ?? []).map((r: any) => r.id);
  const counts: Record<string, number> = {};
  if (ids.length) {
    const { data: cs } = await supa.from("asset_source_refs")
      .select("source_account_id", { count: "exact", head: false }).in("source_account_id", ids);
    (cs ?? []).forEach((r: any) => { counts[r.source_account_id] = (counts[r.source_account_id] ?? 0) + 1; });
  }
  return c.json({
    accounts: (data ?? []).map((r: any) => ({
      id: r.id, provider_id: r.provider_id, provider_kind: r.provider?.kind ?? null,
      display_label: r.display_label, status: r.status,
      connected_at: r.connected_at, disconnected_at: r.disconnected_at,
      asset_count: counts[r.id] ?? 0, last_sync_at: null,
    })),
  });
});

app.get("/:id/status", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: acc } = await supa.from("source_accounts").select("*").eq("id", id).maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  const [{ data: lastJob }, { data: cursor }, { data: lastErr }] = await Promise.all([
    supa.from("source_sync_jobs").select("*").eq("source_account_id", id).order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supa.from("source_sync_cursors").select("*").eq("source_account_id", id).maybeSingle(),
    supa.from("source_errors").select("message, occurred_at").eq("source_account_id", id).order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const { count } = await supa.from("asset_source_refs").select("id", { count: "exact", head: true }).eq("source_account_id", id);
  return c.json({
    account_id: id, status: acc.status,
    last_job: {
      id: lastJob?.id ?? null, kind: lastJob?.kind ?? null, status: lastJob?.status ?? null,
      started_at: lastJob?.started_at ?? null, finished_at: lastJob?.finished_at ?? null,
      stats: lastJob?.stats ?? {},
    },
    cursor_age_seconds: cursor ? Math.floor((Date.now() - new Date(cursor.updated_at).getTime()) / 1000) : null,
    last_error: lastErr?.message ?? null,
    progress: { discovered: count ?? 0, indexed: count ?? 0 },
  });
});

app.post("/connect", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "connect");
  const body = await parseBody(c, ConnectIn);
  const reqHash = await hashJson(body);
  const cached = await findIdempotent(c, "sources.connect", reqHash);
  if (cached && "conflict" in cached) throw new ApiError("conflict", "Idempotency-Key reused with different payload");
  if (cached?.response) return c.json(cached.response, cached.status as 200);

  // Verify provider exists
  const { data: provider } = await supa.from("source_providers").select("*").eq("id", body.provider_id).maybeSingle();
  if (!provider) throw new ApiError("not_found", "Provider not found");

  const state = crypto.randomUUID();
  const svc = getServiceClient();
  await svc.from("api_oauth_states").insert({
    state, user_id: uid, provider_id: body.provider_id, redirect_uri: body.redirect_uri ?? ENV.APP_REDIRECT_URL,
  });

  const oauth = provider.oauth_config ?? {};
  let authorize_url: string | null = null;
  let session_token: string | null = null;

  if (oauth.authorize_url) {
    const u = new URL(oauth.authorize_url);
    u.searchParams.set("state", state);
    u.searchParams.set("redirect_uri", `${ENV.SUPABASE_URL}/functions/v1/sources/callback`);
    if (oauth.client_id) u.searchParams.set("client_id", oauth.client_id);
    if (oauth.scope) u.searchParams.set("scope", oauth.scope);
    u.searchParams.set("response_type", "code");
    authorize_url = u.toString();
  } else {
    // Local / export providers: return a one-time session token
    session_token = state;
  }

  const out = { authorize_url, session_token, state };
  await storeIdempotent(c, "sources.connect", reqHash, out, 200);
  emitEvent(c, "sources.connect_initiated", { provider: provider.kind });
  return c.json(out);
});

app.get("/callback", async (c) => {
  // SERVICE ROLE: store tokens, create account. We intentionally bypass RLS here.
  const { code, state, error } = parseQuery(c, z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1),
    error: z.string().optional(),
  }));
  const svc = getServiceClient();
  const { data: st } = await svc.from("api_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st) return c.redirect(`${ENV.APP_REDIRECT_URL}/connect/error?reason=invalid_state`);
  await svc.from("api_oauth_states").delete().eq("state", state);
  if (error || !code) return c.redirect(`${st.redirect_uri ?? ENV.APP_REDIRECT_URL}/connect/error?reason=${error ?? "no_code"}`);

  // Token exchange is provider-specific; we record a placeholder encrypted token.
  // Real token exchange wired in connector prompt. For now we store the auth code
  // as a stub so the flow is end-to-end testable.
  const { data: account, error: accErr } = await svc.from("source_accounts").insert({
    user_id: st.user_id, provider_id: st.provider_id, status: "active",
    external_account_id: `pending_${state.slice(0, 8)}`,
  }).select().single();
  if (accErr) return c.redirect(`${st.redirect_uri}/connect/error?reason=account_create_failed`);

  await svc.from("source_tokens").insert({
    source_account_id: account.id,
    access_token_encrypted: `STUB_${btoa(code)}`,
  });
  await svc.from("source_permissions").insert({
    source_account_id: account.id, can_cache_thumbnail: false, can_cache_preview: false, ai_allowed: false,
  });

  // Snapshot capability
  const { data: provider } = await svc.from("source_providers").select("default_capabilities").eq("id", st.provider_id).single();
  await svc.from("source_capabilities").insert({
    source_account_id: account.id, capability: provider?.default_capabilities ?? {},
  });

  await jobEnqueuer.enqueue("source.initial_sync",
    { source_account_id: account.id }, { userId: st.user_id, priority: 3 });

  return c.redirect(`${st.redirect_uri}/connect/success?account=${account.id}`);
});

app.post("/:id/sync", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: acc } = await supa.from("source_accounts").select("id").eq("id", id).maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  const job = await jobEnqueuer.enqueue("source.incremental_sync",
    { source_account_id: id }, { userId: uid, priority: 5 });
  emitEvent(c, "sources.sync_enqueued", { id });
  return c.json({ job_id: job.id }, 202);
});

app.delete("/:id", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "delete");
  // Ownership check via user client (RLS)
  const { data: acc } = await supa.from("source_accounts").select("id").eq("id", id).maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  // Service-role cascade
  const svc = getServiceClient();
  const { error } = await svc.rpc("disconnect_source", { _source_account_id: id });
  if (error) throw new ApiError("internal", error.message);
  await cache.invalidateUser(uid);
  emitEvent(c, "sources.disconnected", { id });
  return c.json({ status: "disconnecting", account_id: id }, 202);
});

Deno.serve(app.fetch);

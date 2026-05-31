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
    // Prefer credentials from edge function secrets over seeded oauth_config
    // so client IDs never live in the database.
    const envClientId = provider.kind === "google_photos"
      ? Deno.env.get("GOOGLE_CLIENT_ID")
      : undefined;
    const clientId = envClientId ?? oauth.client_id;
    if (clientId) u.searchParams.set("client_id", clientId);
    if (oauth.scope) u.searchParams.set("scope", oauth.scope);
    if (oauth.access_type) u.searchParams.set("access_type", oauth.access_type);
    if (oauth.prompt) u.searchParams.set("prompt", oauth.prompt);
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
  if (!st) return c.redirect(`${ENV.APP_REDIRECT_URL}/sources?error=invalid_state`);
  await svc.from("api_oauth_states").delete().eq("state", state);
  const base = st.redirect_uri ?? ENV.APP_REDIRECT_URL;
  if (error || !code) return c.redirect(`${base}/sources?error=${error ?? "no_code"}`);

  // Look up the provider to know how to exchange the auth code.
  const { data: provider } = await svc.from("source_providers")
    .select("kind, oauth_config, default_capabilities").eq("id", st.provider_id).single();
  if (!provider) return c.redirect(`${base}/sources?error=unknown_provider`);

  // Provider-specific token exchange. Google Photos is the primary supported
  // provider; other providers fall back to placeholder so the connection row
  // exists and can be re-authed later.
  let access_token: string | null = null;
  let refresh_token: string | null = null;
  let expires_at: string | null = null;

  try {
    if (provider.kind === "google_photos") {
      const cid = Deno.env.get("GOOGLE_CLIENT_ID");
      const cs = Deno.env.get("GOOGLE_CLIENT_SECRET");
      if (!cid || !cs) return c.redirect(`${base}/sources?error=oauth_not_configured`);
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: cid,
          client_secret: cs,
          redirect_uri: `${ENV.SUPABASE_URL}/functions/v1/sources/callback`,
          grant_type: "authorization_code",
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        return c.redirect(`${base}/sources?error=token_exchange_failed&detail=${encodeURIComponent(txt.slice(0, 120))}`);
      }
      const j = await r.json() as { access_token: string; refresh_token?: string; expires_in?: number };
      access_token = j.access_token;
      refresh_token = j.refresh_token ?? null;
      expires_at = j.expires_in
        ? new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString()
        : null;
    }
  } catch (e) {
    return c.redirect(`${base}/sources?error=token_exchange_threw&detail=${encodeURIComponent((e as Error).message.slice(0, 120))}`);
  }

  const { data: account, error: accErr } = await svc.from("source_accounts").insert({
    user_id: st.user_id,
    provider_id: st.provider_id,
    status: "active",
    external_account_id: `acct_${state.slice(0, 8)}`,
  } as Record<string, unknown>).select().single();
  if (accErr) return c.redirect(`${base}/sources?error=account_create_failed&detail=${encodeURIComponent(accErr.message.slice(0, 120))}`);

  if (access_token) {
    await svc.from("source_tokens").insert({
      source_account_id: account.id,
      access_token_encrypted: access_token, // TODO: encrypt at rest
      refresh_token_encrypted: refresh_token,
      expires_at,
    });
  } else {
    // Placeholder so the FK row exists (non-OAuth or pending providers).
    await svc.from("source_tokens").insert({
      source_account_id: account.id,
      access_token_encrypted: "",
    });
  }
  await svc.from("source_permissions").insert({
    source_account_id: account.id, can_cache_thumbnail: false, can_cache_preview: false, ai_allowed: false,
  });

  await svc.from("source_capabilities").insert({
    source_account_id: account.id, capability: provider?.default_capabilities ?? {},
  });

  await jobEnqueuer.enqueue("syncSource",
    { source_account_id: account.id, mode: "initial" }, { userId: st.user_id, priority: 3 });

  return c.redirect(`${base}/sources?connected=${account.id}`);
});

app.post("/:id/sync", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: acc } = await supa.from("source_accounts").select("id").eq("id", id).maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  const job = await jobEnqueuer.enqueue("syncSource",
    { source_account_id: id, mode: "incremental" }, { userId: uid, priority: 5 });
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

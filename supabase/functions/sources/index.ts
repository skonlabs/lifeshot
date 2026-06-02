import { z, type Context } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseParams, parseQuery } from "../_shared/validation.ts";
import { sendError, ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { getServiceClient } from "../_shared/clients.ts";
import { jobEnqueuer } from "../_shared/interfaces.ts";
import { cache, keys } from "../_shared/cache.ts";
import { emitEvent } from "../_shared/observability.ts";
import { ENV } from "../_shared/env.ts";
import { getConnector } from "../_sources/registry.ts";

// Wake the worker so the job claims within a couple of seconds instead of
// waiting for the next pg_cron tick (~15s). The request must go to the
// Supabase Functions origin, not the public app URL; otherwise it 404s and
// the job sits in `pending` until cron eventually picks it up.
function kickWorker(authHeader?: string | null, requestUrl?: string | null) {
  // deno-lint-ignore no-explicit-any
  const globalAny = globalThis as any;
  const candidates = [requestUrl, ENV.SUPABASE_URL].filter(Boolean) as string[];
  const base = candidates
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "";
      }
    })
    .find((origin) => origin.includes(".supabase.co"));
  if (!base) return;
  const workerUrl = `${base}/functions/v1/worker/drain`;
  const secret = Deno.env.get("WORKER_SECRET") ?? "";
  const authorization = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader
    : `Bearer ${ENV.SUPABASE_ANON_KEY}`;
  const nudge = fetch(workerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { "authorization": authorization } : {}),
      ...(secret ? { "x-worker-secret": secret } : {}),
    },
    body: JSON.stringify({}),
  }).catch((err) => console.warn("kickWorker nudge failed:", String(err)));
  if (globalAny.EdgeRuntime?.waitUntil) {
    globalAny.EdgeRuntime.waitUntil(nudge);
  }
}

function isMissingColumnError(message?: string | null, column?: string) {
  if (!message || !column) return false;
  const normalized = message.toLowerCase();
  const target = column.toLowerCase();
  return (
    normalized.includes(`could not find the '${target}' column`) ||
    (normalized.includes(target) && normalized.includes("schema cache")) ||
    (normalized.includes(target) && normalized.includes("does not exist"))
  );
}

const ConnectIn = z.object({
  provider_id: z.string().uuid(),
  redirect_uri: z.string().url().max(2048).optional(),
}).strict();

const ContainerRef = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(512).optional(),
  path: z.string().min(1).max(2048).optional(),
}).strict();

const UpdateContainersIn = z.object({
  containers: z.array(ContainerRef).max(200),
}).strict();

const ListContainersQuery = z.object({
  parent_id: z.string().min(1).max(512).optional(),
}).strict();

const app = createApi("/sources");
// Redeploy marker v4: surface listAlbums errors via debug field.

// Hardcoded OAuth metadata for known providers. We do NOT rely on
// source_providers.oauth_config being seeded — if a row is missing the
// config (older DB state, failed migration), the connect endpoint still
// works as long as the matching edge secret is set.
type OAuthMeta = {
  authorize_url: string;
  token_url: string;
  scope: string;
  extra?: Record<string, string>;
  clientIdEnv: string;
  clientSecretEnv: string;
};
const OAUTH_META: Record<string, OAuthMeta> = {
  google_photos: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/photoslibrary.readonly",
    extra: { access_type: "offline", prompt: "consent" },
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  },
  dropbox: {
    authorize_url: "https://www.dropbox.com/oauth2/authorize",
    token_url: "https://api.dropboxapi.com/oauth2/token",
    scope: "files.metadata.read files.content.read account_info.read",
    extra: { token_access_type: "offline" },
    clientIdEnv: "DROPBOX_APP_KEY",
    clientSecretEnv: "DROPBOX_APP_SECRET",
  },
  onedrive: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access Files.Read User.Read",
    extra: { response_mode: "query", prompt: "consent" },
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
  },
};

const CALLBACK_PATHS = [
  "/functions/v1/sources/callback",
  "/functions/v1/sources/v1/callback",
] as const;
const OAUTH_CALLBACK_URL = `${ENV.SUPABASE_URL}${CALLBACK_PATHS[0]}`;

type ContainerRefOut = {
  id: string;
  name?: string;
  path?: string;
  selectable?: boolean;
  has_children?: boolean;
};

type SourceSelectionStats = {
  folder_count: number;
  photo: number;
  video: number;
  document: number;
  audio: number;
  other: number;
};

const ZERO_SELECTION_STATS: SourceSelectionStats = {
  folder_count: 0,
  photo: 0,
  video: 0,
  document: 0,
  audio: 0,
  other: 0,
};

async function getSelectedContainers(svc: ReturnType<typeof getServiceClient>, sourceAccountId: string): Promise<ContainerRefOut[]> {
  const { data, error } = await svc.from("source_permissions")
    .select("scopes")
    .eq("source_account_id", sourceAccountId)
    .maybeSingle();
  if (error) throw new ApiError("internal", error.message);
  const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
  const selected = scopes.find((entry: unknown) => {
    return !!entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "selected_containers";
  }) as { containers?: ContainerRefOut[] } | undefined;
  return Array.isArray(selected?.containers)
    ? selected!.containers.filter((item) => item && typeof item.id === "string")
    : [];
}

async function setSelectedContainers(svc: ReturnType<typeof getServiceClient>, sourceAccountId: string, containers: ContainerRefOut[]) {
  const { data, error } = await svc.from("source_permissions")
    .select("id, scopes")
    .eq("source_account_id", sourceAccountId)
    .maybeSingle();
  if (error) throw new ApiError("internal", error.message);

  const nextScopes = (Array.isArray(data?.scopes) ? data.scopes : [])
    .filter((entry: unknown) => !(entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "selected_containers"));

  if (containers.length) {
    nextScopes.push({ type: "selected_containers", containers });
  }

  if (data?.id) {
    const { error: updateError } = await svc.from("source_permissions")
      .update({ scopes: nextScopes })
      .eq("id", data.id);
    if (updateError) throw new ApiError("internal", updateError.message);
    return;
  }

  const { error: insertError } = await svc.from("source_permissions").insert({
    source_account_id: sourceAccountId,
    can_cache_thumbnail: false,
    can_cache_preview: false,
    ai_allowed: false,
    scopes: nextScopes,
  });
  if (insertError) throw new ApiError("internal", insertError.message);
}

async function listSelectableContainers(
  providerKind: string,
  sourceAccountId: string,
  userId: string,
  parentId?: string | null,
): Promise<ContainerRefOut[]> {
  // For providers with a server-side listing API, fetch the available
  // albums/folders. For on-device or upload-style providers the server
  // can't browse the user's filesystem — the UI lets the user add folder
  // paths/names manually (free-form), which still get persisted as the
  // account's selected containers.
  const API_LISTABLE = new Set(["google_photos", "dropbox", "onedrive"]);
  if (!API_LISTABLE.has(providerKind)) return [];
  try {
    const connector = getConnector(providerKind as any, {
      source_account_id: sourceAccountId,
      user_id: userId,
      provider_kind: providerKind as any,
    }, getServiceClient());
    const albums = await connector.listAlbums(parentId);
    return albums.map((album: any) => ({
      id: album.id,
      name: album.name,
      path: album.path,
      selectable: album.selectable,
      has_children: album.has_children,
    } as ContainerRefOut & { selectable?: boolean; has_children?: boolean }));
  } catch (err) {
    console.error("listSelectableContainers failed", providerKind, sourceAccountId, err);
    return [];
  }
}

async function getSelectionStats(providerKind: string, sourceAccountId: string, userId: string): Promise<SourceSelectionStats | null> {
  const API_LISTABLE = new Set(["google_photos", "dropbox", "onedrive"]);
  if (!API_LISTABLE.has(providerKind)) return ZERO_SELECTION_STATS;
  try {
    const connector = getConnector(providerKind as any, {
      source_account_id: sourceAccountId,
      user_id: userId,
      provider_kind: providerKind as any,
    }, getServiceClient());
    if (!connector.countSelectionStats) return ZERO_SELECTION_STATS;
    return await connector.countSelectionStats();
  } catch (err) {
    console.error("countSelectionStats failed", providerKind, sourceAccountId, err);
    return null;
  }
}

// Providers list (public-ish: seeded reference data)
app.get("/v1/providers", async (c) => {
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

// Authenticated API routes live under /v1/*; OAuth callback stays public.
app.use("/v1/*", (await import("../_shared/auth.ts")).withAuth);

app.get("/v1/accounts", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const { data, error } = await supa.from("source_accounts").select(`
    id, user_id, provider_id, display_label, status, connected_at, disconnected_at, last_synced_at,
    provider:source_providers(kind)
  `).order("connected_at", { ascending: false });
  if (error) throw new ApiError("internal", error.message);
  // Per-account counts, broken out by media_type so the UI can show
  // photos / videos / documents / other in addition to the total indexed.
  const ids = (data ?? []).map((r: any) => r.id);
  const counts: Record<string, number> = {};
  const breakdown: Record<string, { photo: number; video: number; document: number; audio: number; other: number }> = {};
  if (ids.length) {
    // Use the service client to avoid RLS/embedding pitfalls when joining
    // asset_source_refs -> assets. Fetch the two tables separately and
    // aggregate in code so each account gets accurate per-kind counts.
    const svc = getServiceClient();
    const { data: refs, error: refsErr } = await svc.from("asset_source_refs")
      .select("source_account_id, asset_id")
      .in("source_account_id", ids);
    if (refsErr) throw new ApiError("internal", refsErr.message);
    const assetIds = Array.from(new Set((refs ?? []).map((r: any) => r.asset_id).filter(Boolean)));
    const mediaByAsset = new Map<string, string>();
    // Chunk the IN(...) to stay under URL length limits.
    const CHUNK = 500;
    for (let i = 0; i < assetIds.length; i += CHUNK) {
      const slice = assetIds.slice(i, i + CHUNK);
      const { data: rows, error: aErr } = await svc.from("assets")
        .select("id, media_type").in("id", slice);
      if (aErr) throw new ApiError("internal", aErr.message);
      for (const row of (rows ?? []) as Array<{ id: string; media_type: string }>) {
        mediaByAsset.set(row.id, row.media_type);
      }
    }
    for (const row of (refs ?? []) as Array<{ source_account_id: string; asset_id: string }>) {
      counts[row.source_account_id] = (counts[row.source_account_id] ?? 0) + 1;
      const bucket = breakdown[row.source_account_id] ??= { photo: 0, video: 0, document: 0, audio: 0, other: 0 };
      const kind = mediaByAsset.get(row.asset_id) ?? "unknown";
      if (kind === "photo" || kind === "live_photo" || kind === "animation") bucket.photo += 1;
      else if (kind === "video") bucket.video += 1;
      else if (kind === "document") bucket.document += 1;
      else if (kind === "audio") bucket.audio += 1;
      else bucket.other += 1;
    }
  }
  const accountMeta = new Map<string, { providerKind: string; userId: string }>();
  for (const row of (data ?? []) as Array<{ id: string; user_id?: string; provider?: { kind?: string } | null }>) {
    accountMeta.set(row.id, {
      providerKind: row.provider?.kind ?? "",
      userId: row.user_id ?? uid,
    });
  }
  const scopesByAccount = new Map<string, ContainerRefOut[]>();
  if (ids.length) {
    const { data: perms, error: permsError } = await supa.from("source_permissions")
      .select("source_account_id, scopes")
      .in("source_account_id", ids);
    if (permsError) throw new ApiError("internal", permsError.message);
    for (const row of (perms ?? []) as Array<{ source_account_id: string; scopes?: unknown }>) {
      const scopes = Array.isArray(row.scopes) ? row.scopes : [];
      const selected = scopes.find((entry: unknown) => {
        return !!entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "selected_containers";
      }) as { containers?: ContainerRefOut[] } | undefined;
      scopesByAccount.set(row.source_account_id, Array.isArray(selected?.containers) ? selected!.containers : []);
    }
  }
  // Selection totals should reflect the provider's TOTAL contents inside the
  // selected folders/albums, not just the subset already indexed locally.
  // Cache the provider count briefly so the Sources page can refresh often
  // without repeatedly crawling Dropbox/OneDrive on every poll tick.
  const liveStatsByAccount = new Map<string, SourceSelectionStats>(await Promise.all(
    (data ?? []).map(async (row: any) => {
      const b = breakdown[row.id] ?? { photo: 0, video: 0, document: 0, audio: 0, other: 0 };
      const fallback: SourceSelectionStats = {
        folder_count: (scopesByAccount.get(row.id) ?? []).length,
        photo: b.photo,
        video: b.video,
        document: b.document,
        audio: b.audio,
        other: b.other,
      };
      const selectedContainers = scopesByAccount.get(row.id) ?? [];
      if (!selectedContainers.length || !row.provider?.kind) {
        return [row.id, fallback] as const;
      }

      const cacheKey = `v1:source-selection-stats:${row.id}`;
      const cached = await cache.get<SourceSelectionStats>(c, cacheKey);
      if (cached) return [row.id, cached] as const;

      const liveStats = await getSelectionStats(row.provider.kind, row.id, row.user_id ?? uid);
      const resolved = liveStats ?? fallback;
      if (liveStats) {
        await cache.set(c, cacheKey, liveStats, 300, row.user_id ?? uid);
      }
      return [row.id, resolved] as const;
    }),
  ));
  return c.json({
    accounts: (data ?? []).map((r: any) => {
      const selectionStats = liveStatsByAccount.get(r.id) ?? ZERO_SELECTION_STATS;
      return {
        id: r.id, provider_id: r.provider_id, provider_kind: r.provider?.kind ?? null,
        display_label: r.display_label, status: r.status,
        connected_at: r.connected_at, disconnected_at: r.disconnected_at,
        asset_count: counts[r.id] ?? 0, last_sync_at: r.last_synced_at ?? null,
        selected_container_count: selectionStats.folder_count,
        selected_containers: scopesByAccount.get(r.id) ?? [],
        counts_by_kind: breakdown[r.id] ?? ZERO_SELECTION_STATS,
        selection_counts_by_kind: {
          photo: selectionStats.photo,
          video: selectionStats.video,
          document: selectionStats.document,
          audio: selectionStats.audio,
          other: selectionStats.other,
        },
      };
    }),
  });
});

app.get("/v1/:id/status", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: acc } = await supa.from("source_accounts").select("*").eq("id", id).maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  const svc = getServiceClient();
  const [lastJobRes, cursorRes, lastErrRes, activeJobRes, latestQueueJobRes, indexedRes] = await Promise.all([
    svc.from("source_sync_jobs").select("*").eq("source_account_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("source_sync_cursors").select("*").eq("source_account_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("source_errors").select("message, occurred_at").eq("source_account_id", id).eq("resolved", false).order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("job_queue")
      .select("id, status, job_name, payload, created_at, started_at, finished_at, last_error, attempts")
      .eq("job_name", "syncSource")
      .in("status", ["pending", "running"])
      .contains("payload", { source_account_id: id })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc.from("job_queue")
      .select("id, status, job_name, payload, created_at, started_at, finished_at, last_error, attempts")
      .eq("job_name", "syncSource")
      .contains("payload", { source_account_id: id })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc.from("asset_source_refs").select("id", { count: "exact", head: true }).eq("source_account_id", id),
  ]);
  if (lastJobRes.error) throw new ApiError("internal", lastJobRes.error.message);
  if (cursorRes.error) throw new ApiError("internal", cursorRes.error.message);
  if (lastErrRes.error) throw new ApiError("internal", lastErrRes.error.message);
  if (activeJobRes.error) throw new ApiError("internal", activeJobRes.error.message);
  if (latestQueueJobRes.error) throw new ApiError("internal", latestQueueJobRes.error.message);
  if (indexedRes.error) throw new ApiError("internal", indexedRes.error.message);
  const lastJob = lastJobRes.data;
  const cursor = cursorRes.data;
  const lastErr = lastErrRes.data;
  const activeJob = activeJobRes.data;
  const latestQueueJob = latestQueueJobRes.data;
  const queueJob = activeJob ?? latestQueueJob ?? null;
  const indexed = indexedRes.count ?? 0;
  // Keep queue state and persisted sync-job state aligned to the same job when
  // possible. Previously we mixed the latest queued job status with a different
  // source_sync_jobs row, which could leave the UI stuck on stale stats.
  const matchingPersistedJob = queueJob && lastJob?.id === queueJob.id ? lastJob : null;
  const effectiveJobStatus = activeJob?.status ?? latestQueueJob?.status ?? lastJob?.status ?? null;
  const effectiveJobKind = matchingPersistedJob?.kind ?? lastJob?.kind ?? (queueJob ? "syncSource" : null);
  const persistedJobStats = ((matchingPersistedJob ?? lastJob)?.stats && typeof (matchingPersistedJob ?? lastJob)?.stats === "object")
    ? ((matchingPersistedJob ?? lastJob)?.stats as Record<string, unknown>)
    : {};
  const queueJobStats = queueJob ? {
    stage: activeJob ? (persistedJobStats.stage ?? "listing") : (persistedJobStats.stage ?? "queued"),
    discovered: Math.max(Number(persistedJobStats.discovered ?? 0), indexed, 1),
    indexed,
    queue_attempts: Number(queueJob.attempts ?? 0),
    queue_error: queueJob.last_error ?? null,
  } : {};
  const jobStats = { ...persistedJobStats, ...queueJobStats };
  const discovered = Math.max(Number(jobStats.discovered ?? 0), indexed, queueJob ? 1 : 0);
  const progressIndexed = indexed;
  const lastErrorMessage = lastErr?.message ?? queueJob?.last_error ?? null;
  const unauthorized = /unauthorized/i.test(lastErrorMessage ?? "");
  // Only show syncing if there is actually an active (pending/running) job in
  // the queue. source_sync_jobs.status alone can show "running" stale if the
  // job failed and was never cleaned up by syncSource's own error handling.
  const syncing = !unauthorized && !!activeJob && (effectiveJobStatus === "pending" || effectiveJobStatus === "running");
  const accountStatus = unauthorized ? "revoked" : (syncing ? "syncing" : acc.status);
  return c.json({
    account_id: id,
    status: accountStatus,
    last_job: {
      id: queueJob?.id ?? lastJob?.id ?? null,
      kind: effectiveJobKind,
      status: effectiveJobStatus,
      started_at: queueJob?.started_at ?? matchingPersistedJob?.started_at ?? lastJob?.started_at ?? null,
      finished_at: syncing ? null : (lastJob?.finished_at ?? queueJob?.finished_at ?? null),
      stats: jobStats,
    },
    cursor_age_seconds: cursor ? Math.floor((Date.now() - new Date(cursor.updated_at).getTime()) / 1000) : null,
    last_error: unauthorized ? "Authorization expired. Please reconnect this source." : lastErrorMessage,
    progress: { discovered, indexed: progressIndexed },
  });
});

app.get("/v1/:id/containers", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const { parent_id } = parseQuery(c, ListContainersQuery);
  await enforceRateLimit(uid, "general");
  const { data: acc, error } = await supa.from("source_accounts")
    .select("id, user_id, provider:source_providers(kind)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError("internal", error.message);
  if (!acc) throw new ApiError("not_found", "Source account not found");

  const svc = getServiceClient();
  const kind = (acc as { provider?: { kind?: string } | null }).provider?.kind ?? "";
  const containers = await listSelectableContainers(kind, acc.id, acc.user_id, parent_id ?? null);
  const selected = await getSelectedContainers(svc, acc.id);
  return c.json({ containers, selected, parent_id: parent_id ?? null });
});

// Alias kept for compatibility with older clients/builds.
app.get("/v1/:id/folders", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const { parent_id } = parseQuery(c, ListContainersQuery);
  await enforceRateLimit(uid, "general");
  const { data: acc, error } = await supa.from("source_accounts")
    .select("id, user_id, provider:source_providers(kind)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError("internal", error.message);
  if (!acc) throw new ApiError("not_found", "Source account not found");
  const svc = getServiceClient();
  const kind = (acc as { provider?: { kind?: string } | null }).provider?.kind ?? "";
  const containers = await listSelectableContainers(kind, acc.id, acc.user_id, parent_id ?? null);
  const selected = await getSelectedContainers(svc, acc.id);
  return c.json({ containers, selected, parent_id: parent_id ?? null });
});

app.patch("/v1/:id/containers", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const body = await parseBody(c, UpdateContainersIn);
  await enforceRateLimit(uid, "general");
  const { data: acc, error } = await supa.from("source_accounts")
    .select("id, user_id, status, provider:source_providers(kind)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError("internal", error.message);
  if (!acc) throw new ApiError("not_found", "Source account not found");

  const svc = getServiceClient();
  const normalized = body.containers
    .filter((item, index, arr) => arr.findIndex((other) => other.id === item.id) === index)
    .map((item) => ({ id: item.id, name: item.name, path: item.path }));

  await setSelectedContainers(svc, acc.id, normalized);
  await cache.del(c, `v1:source-selection-stats:${acc.id}`);

  const { data: refs, error: refsError } = await svc.from("asset_source_refs")
    .select("asset_id")
    .eq("source_account_id", acc.id);
  if (refsError) throw new ApiError("internal", refsError.message);

  await svc.from("asset_source_refs").delete().eq("source_account_id", acc.id);
  await svc.from("source_sync_cursors").delete().eq("source_account_id", acc.id);
  await svc.from("source_accounts").update({ status: "active" }).eq("id", acc.id);

  const assetIds = Array.from(new Set((refs ?? []).map((row: { asset_id: string | null }) => row.asset_id).filter(Boolean)));
  if (assetIds.length) {
    const { data: remaining, error: remainingError } = await svc.from("asset_source_refs")
      .select("asset_id")
      .in("asset_id", assetIds);
    if (remainingError) throw new ApiError("internal", remainingError.message);
    const remainingIds = new Set((remaining ?? []).map((row: { asset_id: string }) => row.asset_id));
    const orphanedIds = assetIds.filter((assetId) => !remainingIds.has(assetId));
    if (orphanedIds.length) {
      const { error: orphanedError } = await svc.from("assets")
        .update({ deleted_state: "soft_deleted" })
        .in("id", orphanedIds);
      if (orphanedError) throw new ApiError("internal", orphanedError.message);
    }
  }

  // Do NOT auto-enqueue sync here. The user must click the Sync button
  // explicitly on the source row to trigger indexing.
  return c.json({ updated: true, selected_count: normalized.length });
});

app.post("/v1/connect", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "connect");
  const body = await parseBody(c, ConnectIn);

  // Verify provider exists
  const { data: provider } = await supa.from("source_providers").select("*").eq("id", body.provider_id).maybeSingle();
  if (!provider) throw new ApiError("not_found", "Provider not found");

  const state = crypto.randomUUID();
  const svc = getServiceClient();
  await svc.from("api_oauth_states").insert({
    state, user_id: uid, provider_id: body.provider_id, redirect_uri: body.redirect_uri ?? ENV.APP_REDIRECT_URL,
  });

  let authorize_url: string | null = null;
  let session_token: string | null = null;
  let upload_target: { bucket: string; prefix: string } | null = null;

  const meta = OAUTH_META[provider.kind];
  if (meta) {
    const clientId = Deno.env.get(meta.clientIdEnv);
    if (!clientId) {
      throw new ApiError(
        "failed_precondition",
        `${provider.name} is not configured. Set ${meta.clientIdEnv} and ${meta.clientSecretEnv} in edge function secrets.`,
      );
    }
    const u = new URL(meta.authorize_url);
    u.searchParams.set("state", state);
    u.searchParams.set("redirect_uri", OAUTH_CALLBACK_URL);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", meta.scope);
    for (const [k, v] of Object.entries(meta.extra ?? {})) u.searchParams.set(k, v);
    authorize_url = u.toString();
  } else if (provider.kind === "export_import") {
    // Create the account up front so the upload UI can target it
    const { data: account, error: accErr } = await svc.from("source_accounts").insert({
      user_id: uid, provider_id: provider.id, provider_kind: provider.kind, status: "active",
      external_account_id: `upload_${state.slice(0, 8)}`,
      display_label: "Uploaded files",
    }).select().single();
    if (accErr) throw new ApiError("internal", accErr.message);
    await svc.from("source_tokens").insert({ source_account_id: account.id, access_token_encrypted: "" });
    await svc.from("source_permissions").insert({
      source_account_id: account.id, can_cache_thumbnail: true, can_cache_preview: true, ai_allowed: true,
    });
    await svc.from("source_capabilities").insert({
      source_account_id: account.id, capability: provider.default_capabilities ?? {},
    });
    upload_target = { bucket: "source_uploads", prefix: `${uid}/${account.id}` };
    session_token = account.id;
  } else {
    // No OAuth config and not export_import: this provider can't be
    // connected from the web. Surface a clear error instead of silently
    // returning a useless response — the UI used to show "Connection
    // started" and stall forever.
    throw new ApiError(
      "failed_precondition",
      `${provider.name} can't be connected from the web yet. Use Export/Import (zip upload) or the desktop/mobile agent when available.`,
    );
  }

  const out = { authorize_url, session_token, state, upload_target };
  emitEvent(c, "sources.connect_initiated", { provider: provider.kind });
  return c.json(out);
});

async function handleOAuthCallback(c: Context) {
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
  const base = st.redirect_uri ?? `${ENV.APP_REDIRECT_URL}/sources`;
  const callbackUrl = new URL(base, ENV.APP_REDIRECT_URL);
  if (error || !code) {
    callbackUrl.searchParams.set("error", error ?? "no_code");
    return c.redirect(callbackUrl.toString());
  }

  // Look up the provider to know how to exchange the auth code.
  const { data: provider } = await svc.from("source_providers")
    .select("kind, oauth_config, default_capabilities").eq("id", st.provider_id).single();
  if (!provider) {
    callbackUrl.searchParams.set("error", "unknown_provider");
    return c.redirect(callbackUrl.toString());
  }

  // Provider-specific token exchange. Google Photos is the primary supported
  // provider; other providers fall back to placeholder so the connection row
  // exists and can be re-authed later.
  let access_token: string | null = null;
  let refresh_token: string | null = null;
  let expires_at: string | null = null;

  const tokenEndpoints: Record<string, { url: string; cid?: string; cs?: string }> = {
    google_photos: {
      url: "https://oauth2.googleapis.com/token",
      cid: Deno.env.get("GOOGLE_CLIENT_ID"),
      cs:  Deno.env.get("GOOGLE_CLIENT_SECRET"),
    },
    dropbox: {
      url: "https://api.dropboxapi.com/oauth2/token",
      cid: Deno.env.get("DROPBOX_APP_KEY"),
      cs:  Deno.env.get("DROPBOX_APP_SECRET"),
    },
    onedrive: {
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      cid: Deno.env.get("MICROSOFT_CLIENT_ID"),
      cs:  Deno.env.get("MICROSOFT_CLIENT_SECRET"),
    },
  };

  try {
    const cfg = tokenEndpoints[provider.kind];
    if (cfg) {
      if (!cfg.cid || !cfg.cs) {
        callbackUrl.searchParams.set("error", "oauth_not_configured");
        callbackUrl.searchParams.set("provider", provider.kind);
        return c.redirect(callbackUrl.toString());
      }
      const body = new URLSearchParams({
        code,
        client_id: cfg.cid,
        client_secret: cfg.cs,
        redirect_uri: OAUTH_CALLBACK_URL,
        grant_type: "authorization_code",
      });
      const r = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
        if (!r.ok) {
          const txt = await r.text();
          callbackUrl.searchParams.set("error", "token_exchange_failed");
          callbackUrl.searchParams.set("provider", provider.kind);
          callbackUrl.searchParams.set("detail", txt.slice(0, 160));
          return c.redirect(callbackUrl.toString());
        }
      const j = await r.json() as { access_token: string; refresh_token?: string; expires_in?: number };
      access_token = j.access_token;
      refresh_token = j.refresh_token ?? null;
      expires_at = j.expires_in
        ? new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString()
        : null;
    }
  } catch (e) {
    callbackUrl.searchParams.set("error", "token_exchange_threw");
    callbackUrl.searchParams.set("detail", (e as Error).message.slice(0, 120));
    return c.redirect(callbackUrl.toString());
  }

  const { data: account, error: accErr } = await svc.from("source_accounts").insert({
    user_id: st.user_id,
    provider_id: st.provider_id,
    provider_kind: provider.kind,
    status: "active",
    external_account_id: `acct_${state.slice(0, 8)}`,
  } as Record<string, unknown>).select().single();
  if (accErr) {
    callbackUrl.searchParams.set("error", "account_create_failed");
    callbackUrl.searchParams.set("detail", accErr.message.slice(0, 120));
    return c.redirect(callbackUrl.toString());
  }

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

  // Do NOT auto-enqueue sync here. User must first select folders to index;
  // sync is queued when they save their folder scope (see /v1/:id/containers).
  callbackUrl.searchParams.set("connected", account.id);
  callbackUrl.searchParams.set("provider", provider.kind);
  return c.redirect(callbackUrl.toString());
}

app.get("/callback", handleOAuthCallback);
app.get("/v1/callback", handleOAuthCallback);

app.post("/v1/:id/sync", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: acc } = await supa.from("source_accounts").select("id").eq("id", id).maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  const job = await jobEnqueuer.enqueue("syncSource",
    { source_account_id: id, mode: "incremental" }, { userId: uid, priority: 5 });
  const svc = getServiceClient();
  const { error: clearErrorsError } = await svc.from("source_errors")
    .update({ resolved: true })
    .eq("source_account_id", id)
    .eq("resolved", false);
  if (clearErrorsError) throw new ApiError("internal", clearErrorsError.message);
  const syncStatusAttempt = await svc.from("source_accounts")
    .update({ status: "pending", sync_cancel_requested_at: null }).eq("id", id);
  if (syncStatusAttempt.error) {
    if (isMissingColumnError(syncStatusAttempt.error.message, "sync_cancel_requested_at")) {
      const { error: fallbackStatusError } = await svc.from("source_accounts")
        .update({ status: "pending" }).eq("id", id);
      if (fallbackStatusError) throw new ApiError("internal", fallbackStatusError.message);
    } else {
      throw new ApiError("internal", syncStatusAttempt.error.message);
    }
  }
  const { error: syncJobError } = await svc.from("source_sync_jobs").upsert({
    id: job.id,
    source_account_id: id,
    kind: "incremental",
    status: "pending",
    // Seed `stage` + non-zero `discovered` so the UI immediately shows
    // "Queued for sync…" instead of "Discovering files…" while the worker
    // is still picking up the job. The handler overwrites these on first
    // progress write.
    stats: { stage: "queued", discovered: 1, indexed: 0 },
  }, { onConflict: "id" });
  if (syncJobError) throw new ApiError("internal", syncJobError.message);
  emitEvent(c, "sources.sync_enqueued", { id });
  await kickWorker(c.req.header("Authorization"), c.req.url);
  return c.json({ job_id: job.id }, 202);
});

// Request cancellation of any in-flight sync for this account. The running
// worker checks `sync_cancel_requested_at` at the start of each chained
// page-run and exits early; queued (not-yet-started) jobs are removed so
// nothing new fires.
app.post("/v1/:id/sync/stop", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: acc } = await supa.from("source_accounts").select("id").eq("id", id).maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  const svc = getServiceClient();
  const now = new Date().toISOString();

  // 1) Mark the account so the worker bails out on its next page.
  const { error: cancelFlagError } = await svc.from("source_accounts")
    .update({ sync_cancel_requested_at: now, status: "active" }).eq("id", id);
  if (cancelFlagError) {
    if (isMissingColumnError(cancelFlagError.message, "sync_cancel_requested_at")) {
      const { error: fallbackCancelError } = await svc.from("source_accounts")
        .update({ status: "active" }).eq("id", id);
      if (fallbackCancelError) throw new ApiError("internal", fallbackCancelError.message);
    } else {
      throw new ApiError("internal", cancelFlagError.message);
    }
  }

  // 2) Remove queued (not-yet-started) syncSource jobs for this account.
  await svc.from("job_queue").delete()
    .eq("status", "pending")
    .eq("job_name", "syncSource")
    .contains("payload", { source_account_id: id });

  // 2b) Force-cancel any RUNNING syncSource jobs in the queue for this
  // account. Without this, a worker that has been killed mid-await leaves
  // a row in status='running' that nothing else touches — the UI then shows
  // a perpetual "syncing" state. Marking it failed lets the next Sync
  // request start cleanly and the status endpoint stops reporting active.
  await svc.from("job_queue")
    .update({
      status: "failed",
      dead_letter: true,
      finished_at: now,
      last_error: "cancelled by user",
      locked_at: null,
      locked_by: null,
    })
    .eq("status", "running")
    .eq("job_name", "syncSource")
    .contains("payload", { source_account_id: id });

  // 3) Mark current pending/running source_sync_jobs rows as cancelled.
  await svc.from("source_sync_jobs")
    .update({ status: "cancelled", finished_at: now, stats: { cancelled: true, cancelled_at: now } })
    .eq("source_account_id", id)
    .in("status", ["pending", "running"]);

  emitEvent(c, "sources.sync_cancelled", { id });
  return c.json({ cancelled: true });
});

// After client-side upload to the source_uploads storage bucket, scan the
// folder for this account and enqueue an import job. Returns counts.
app.post("/v1/:id/import-uploaded", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: acc } = await supa.from("source_accounts")
    .select("id, provider:source_providers(kind)").eq("id", id).maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  if ((acc as any).provider?.kind !== "export_import") {
    throw new ApiError("failed_precondition", "This account does not accept uploads");
  }
  const svc = getServiceClient();
  const prefix = `${uid}/${id}`;
  const { data: files, error } = await svc.storage.from("source_uploads").list(prefix, {
    limit: 1000, sortBy: { column: "name", order: "asc" },
  });
  if (error) throw new ApiError("internal", error.message);
  const fileCount = (files ?? []).filter((f) => f.name && !f.name.endsWith("/")).length;
  const job = await jobEnqueuer.enqueue("syncSource",
    { source_account_id: id, mode: "upload_import", bucket: "source_uploads", prefix, file_count: fileCount },
    { userId: uid, priority: 4 });
  const { error: uploadStatusError } = await svc.from("source_accounts").update({ status: "pending" }).eq("id", id);
  if (uploadStatusError) throw new ApiError("internal", uploadStatusError.message);
  const { error: uploadJobError } = await svc.from("source_sync_jobs").upsert({
    id: job.id,
    source_account_id: id,
    kind: "initial",
    status: "pending",
    stats: { discovered: fileCount, indexed: 0 },
  }, { onConflict: "id" });
  if (uploadJobError) throw new ApiError("internal", uploadJobError.message);
  emitEvent(c, "sources.upload_import_enqueued", { id, file_count: fileCount });
  await kickWorker(c.req.header("Authorization"));
  return c.json({ job_id: job.id, queued_files: fileCount }, 202);
});

app.delete("/v1/:id", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "delete");
  // Ownership check via user client (RLS)
  const { data: acc } = await supa.from("source_accounts")
    .select("id, user_id, provider_kind")
    .eq("id", id)
    .maybeSingle();
  if (!acc) throw new ApiError("not_found", "Source account not found");
  const svc = getServiceClient();
  try {
    const connector = getConnector(acc.provider_kind as any, {
      source_account_id: id,
      user_id: acc.user_id,
      provider_kind: acc.provider_kind as any,
    }, svc);
    await connector.revoke();
  } catch (revokeError) {
    console.warn("sources revoke failed", { id, error: revokeError instanceof Error ? revokeError.message : String(revokeError) });
  }
  const { data: refs, error: refsError } = await svc.from("asset_source_refs").select("asset_id").eq("source_account_id", id);
  if (refsError) throw new ApiError("internal", refsError.message);
  const { error: accountError } = await svc.from("source_accounts").update({ status: "disconnected", disconnected_at: new Date().toISOString() }).eq("id", id);
  if (accountError) throw new ApiError("internal", accountError.message);
  const { error: tokenError } = await svc.from("source_tokens").delete().eq("source_account_id", id);
  if (tokenError) throw new ApiError("internal", tokenError.message);
  const { error: permsError } = await svc.from("source_permissions").delete().eq("source_account_id", id);
  if (permsError) throw new ApiError("internal", permsError.message);
  const { error: capsError } = await svc.from("source_capabilities").delete().eq("source_account_id", id);
  if (capsError) throw new ApiError("internal", capsError.message);
  const { error: cursorError } = await svc.from("source_sync_cursors").delete().eq("source_account_id", id);
  if (cursorError) throw new ApiError("internal", cursorError.message);
  const { error: refDeleteError } = await svc.from("asset_source_refs").delete().eq("source_account_id", id);
  if (refDeleteError) throw new ApiError("internal", refDeleteError.message);
  const assetIds = Array.from(new Set((refs ?? []).map((row: { asset_id: string | null }) => row.asset_id).filter(Boolean)));
  if (assetIds.length) {
    const { data: remaining, error: remainingError } = await svc.from("asset_source_refs").select("asset_id").in("asset_id", assetIds);
    if (remainingError) throw new ApiError("internal", remainingError.message);
    const remainingIds = new Set((remaining ?? []).map((row: { asset_id: string }) => row.asset_id));
    const orphanedIds = assetIds.filter((assetId) => !remainingIds.has(assetId));
    if (orphanedIds.length) {
      const { error: assetError } = await svc.from("assets").update({ deleted_state: "soft_deleted" }).in("id", orphanedIds);
      if (assetError) throw new ApiError("internal", assetError.message);
    }
  }
  await cache.invalidateUser(uid);
  emitEvent(c, "sources.disconnected", { id });
  return c.json({ status: "disconnecting", account_id: id }, 202);
});

Deno.serve(app.fetch);

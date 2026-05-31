// deno-lint-ignore-file no-explicit-any
import {
  ConnectorAuthError, ConnectorRateLimitError, ConnectorTransientError,
  type AssetAlbumRef, type AssetRecord, type ConnectorContext, type DeltaResult,
  type PageResult, type SourceCapabilities, type SourceConnector,
} from "./types.ts";

const CAPS: SourceCapabilities = {
  kind: "google_photos",
  authMethod: "oauth2",
  supportsDelta: false,
  supportsWebhook: false,
  canCacheThumbnail: true,
  canCachePreview: false,
  hasExif: true,
  hasLocation: false,
  hasFaceMeta: false,
  supportsVideo: true,
  rateLimitPerMin: 200,
  paginationModel: "page_token",
  originalAccessModel: "url",
  consentRequirements: ["cache_originals"],
  policyRisk: "high",
  runsWhere: "server",
  priority: "P0",
  fallbackStrategy: "export_import",
};

const API = "https://photoslibrary.googleapis.com/v1";

export const googlePhotosFactory = (ctx: ConnectorContext, supabase: any): SourceConnector => {
  // forward decls so getDeltaChanges can call listAssets without `this`
  let listAssetsRef: (cursor: string | null) => Promise<PageResult>;
  async function getSelectedAlbums(): Promise<Array<{ id: string; name?: string }>> {
    const { data } = await supabase.from("source_permissions")
      .select("scopes")
      .eq("source_account_id", ctx.source_account_id)
      .maybeSingle();
    const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
    const selected = scopes.find((entry: unknown) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "selected_containers") as { containers?: Array<{ id: string; name?: string }> } | undefined;
    return Array.isArray(selected?.containers) ? selected!.containers : [];
  }
  async function getAccessToken(): Promise<string> {
    const { data, error } = await supabase.from("source_tokens")
      .select("access_token_encrypted, refresh_token_encrypted, expires_at")
      .eq("source_account_id", ctx.source_account_id).single();
    if (error || !data) throw new ConnectorAuthError("source tokens not found");
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now() + 60_000) {
      // refresh
      const cid = Deno.env.get("GOOGLE_CLIENT_ID"); const cs = Deno.env.get("GOOGLE_CLIENT_SECRET");
      if (!cid || !cs || !data.refresh_token_encrypted) throw new ConnectorAuthError("oauth refresh creds missing");
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cid, client_secret: cs,
          refresh_token: data.refresh_token_encrypted,
          grant_type: "refresh_token",
        }),
      });
      if (!r.ok) throw new ConnectorAuthError(`token refresh failed: ${r.status}`);
      const j = await r.json() as { access_token: string; expires_in: number };
      await supabase.from("source_tokens").update({
        access_token_encrypted: j.access_token,
        expires_at: new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString(),
      }).eq("source_account_id", ctx.source_account_id);
      return j.access_token;
    }
    return data.access_token_encrypted;
  }

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await getAccessToken();
    const r = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (r.status === 401) throw new ConnectorAuthError("unauthorized", true);
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after") ?? "30");
      throw new ConnectorRateLimitError("rate limited", ra);
    }
    if (r.status >= 500) throw new ConnectorTransientError(`upstream ${r.status}`);
    return r;
  }

  function mapItem(it: any): AssetRecord {
    const meta = it.mediaMetadata ?? {};
    const isVideo = !!meta.video;
    return {
      provider_asset_id: it.id,
      media_type: isVideo ? "video" : "image",
      mime_type: it.mimeType,
      capture_time: meta.creationTime,
      created_time: meta.creationTime,
      width: meta.width ? Number(meta.width) : undefined,
      height: meta.height ? Number(meta.height) : undefined,
      duration_ms: meta.video?.duration ? Math.round(Number(String(meta.video.duration).replace("s","")) * 1000) : undefined,
      exif: meta.photo ? {
        iso: meta.photo.isoEquivalent, aperture: meta.photo.apertureFNumber,
        focal_mm: meta.photo.focalLength,
      } : undefined,
      device_make: meta.photo?.cameraMake, device_model: meta.photo?.cameraModel,
      thumbnail_url: it.baseUrl ? `${it.baseUrl}=w512-h512` : undefined,
      provider_url: it.productUrl,
      raw: it,
    };
  }

  const conn: SourceConnector = {
    capabilities: CAPS,
    getCapabilities: () => CAPS,
    authenticate: async () => { await getAccessToken(); },
    refreshToken: async () => { await getAccessToken(); },
    listAssets: async (cursor) => {
      const selectedAlbums = await getSelectedAlbums();
      if (selectedAlbums.length) {
        const state = cursor ? JSON.parse(cursor) as { albumIndex?: number; pageToken?: string | null } : { albumIndex: 0, pageToken: null };
        const albumIndex = Math.max(0, Math.min(selectedAlbums.length - 1, state.albumIndex ?? 0));
        const currentAlbum = selectedAlbums[albumIndex];
        const r = await call("/mediaItems:search", {
          method: "POST",
          body: JSON.stringify({
            albumId: currentAlbum.id,
            pageSize: 100,
            pageToken: state.pageToken ?? undefined,
          }),
        });
        const body = await r.json() as { mediaItems?: any[]; nextPageToken?: string };
        const nextCursor = body.nextPageToken
          ? JSON.stringify({ albumIndex, pageToken: body.nextPageToken })
          : albumIndex < selectedAlbums.length - 1
            ? JSON.stringify({ albumIndex: albumIndex + 1, pageToken: null })
            : null;
        return { items: (body.mediaItems ?? []).map(mapItem), nextCursor } satisfies PageResult;
      }

      const params = new URLSearchParams({ pageSize: "100" });
      if (cursor) params.set("pageToken", cursor);
      const r = await call(`/mediaItems?${params.toString()}`);
      const body = await r.json() as { mediaItems?: any[]; nextPageToken?: string };
      return { items: (body.mediaItems ?? []).map(mapItem), nextCursor: body.nextPageToken ?? null } satisfies PageResult;
    },
    getAssetMetadata: async (id) => {
      const r = await call(`/mediaItems/${id}`);
      return mapItem(await r.json());
    },
    getThumbnail: async (id) => {
      const r = await call(`/mediaItems/${id}`);
      const it = await r.json();
      return { url: `${it.baseUrl}=w512-h512` };
    },
    getPreview: async (id) => {
      const r = await call(`/mediaItems/${id}`);
      const it = await r.json();
      return { url: `${it.baseUrl}=w2048-h2048` };
    },
    getOriginalAccessToken: async (id) => {
      const r = await call(`/mediaItems/${id}`);
      const it = await r.json();
      // Google base URL is short-lived (~60min).
      return { url: `${it.baseUrl}=d`, expiresAt: new Date(Date.now() + 50 * 60 * 1000).toISOString() };
    },
    listAlbums: async () => {
      const r = await call(`/albums?pageSize=50`);
      const j = await r.json() as { albums?: any[] };
      return (j.albums ?? []).map((a) => ({ id: a.id, name: a.title })) as AssetAlbumRef[];
    },
    getDeltaChanges: async (cursor): Promise<DeltaResult> => {
      // Google Photos has no delta; fall back to bounded list with checkpoint.
      const page = await listAssetsRef(cursor);
      return { items: page.items, deleted: [], nextCursor: page.nextCursor };
    },
    disconnect: async () => {
      await supabase.from("source_accounts").update({ status: "disconnected" }).eq("id", ctx.source_account_id);
    },
    revoke: async () => {
      const { data } = await supabase.from("source_tokens").select("access_token_encrypted").eq("source_account_id", ctx.source_account_id).single();
      if (data?.access_token_encrypted) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${data.access_token_encrypted}`, { method: "POST" });
      }
      await supabase.from("source_tokens").update({ access_token_encrypted: "", refresh_token_encrypted: null }).eq("source_account_id", ctx.source_account_id);
      await supabase.from("source_accounts").update({ status: "revoked" }).eq("id", ctx.source_account_id);
    },
  };
  listAssetsRef = conn.listAssets;
  return conn;
};
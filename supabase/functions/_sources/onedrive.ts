// deno-lint-ignore-file no-explicit-any
import {
  ConnectorAuthError,
  ConnectorRateLimitError,
  ConnectorTransientError,
  type AssetRecord,
  type ConnectorContext,
  type DeltaResult,
  type PageResult,
  type SourceCapabilities,
  type SourceConnector,
} from "./types.ts";

const CAPS: SourceCapabilities = {
  kind: "onedrive",
  authMethod: "oauth2",
  supportsDelta: true,
  supportsWebhook: false,
  canCacheThumbnail: true,
  canCachePreview: true,
  hasExif: false,
  hasLocation: false,
  hasFaceMeta: false,
  supportsVideo: true,
  rateLimitPerMin: 120,
  paginationModel: "cursor",
  originalAccessModel: "url",
  consentRequirements: ["cache_originals"],
  policyRisk: "medium",
  runsWhere: "server",
  priority: "P1",
  fallbackStrategy: "export_import",
};

const API = "https://graph.microsoft.com/v1.0";

function inferMimeType(name: string): string | undefined {
  const ext = name.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    avi: "video/x-msvideo",
    webm: "video/webm",
  };
  return map[ext];
}

function isSupportedMedia(name: string, mimeType?: string): boolean {
  const mime = mimeType ?? inferMimeType(name);
  return !!mime && (mime.startsWith("image/") || mime.startsWith("video/"));
}

export const onedriveFactory = (ctx: ConnectorContext, supabase: any): SourceConnector => {
  async function getAccessToken(): Promise<string> {
    const { data, error } = await supabase.from("source_tokens")
      .select("access_token_encrypted, refresh_token_encrypted, expires_at")
      .eq("source_account_id", ctx.source_account_id)
      .single();
    if (error || !data) throw new ConnectorAuthError("source tokens not found");

    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now() + 60_000) {
      const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
      const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
      if (!clientId || !clientSecret || !data.refresh_token_encrypted) {
        throw new ConnectorAuthError("oauth refresh creds missing");
      }

      const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: data.refresh_token_encrypted,
          grant_type: "refresh_token",
        }),
      });
      if (!res.ok) throw new ConnectorAuthError(`token refresh failed: ${res.status}`);
      const json = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
      await supabase.from("source_tokens").update({
        access_token_encrypted: json.access_token,
        refresh_token_encrypted: json.refresh_token ?? data.refresh_token_encrypted,
        expires_at: json.expires_in ? new Date(Date.now() + (json.expires_in - 60) * 1000).toISOString() : null,
      }).eq("source_account_id", ctx.source_account_id);
      return json.access_token;
    }

    return data.access_token_encrypted;
  }

  async function call(url: string): Promise<any> {
    const token = await getAccessToken();
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) throw new ConnectorAuthError("unauthorized", true);
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "30");
      throw new ConnectorRateLimitError("rate limited", retryAfter);
    }
    if (res.status >= 500) throw new ConnectorTransientError(`upstream ${res.status}`);
    if (!res.ok) throw new Error(`onedrive request failed: ${res.status}`);
    return res.json();
  }

  function mapItem(item: any): AssetRecord | null {
    if (!item.file && !item.photo && !item.video) return null;
    const mimeType = item.file?.mimeType ?? inferMimeType(item.name);
    if (!isSupportedMedia(item.name, mimeType)) return null;
    return {
      provider_asset_id: item.id,
      media_type: mimeType?.startsWith("video/") ? "video" : "image",
      mime_type: mimeType,
      capture_time: item.photo?.takenDateTime ?? item.createdDateTime,
      upload_time: item.createdDateTime,
      created_time: item.createdDateTime,
      modified_time: item.lastModifiedDateTime,
      width: item.image?.width ?? item.photo?.width,
      height: item.image?.height ?? item.photo?.height,
      duration_ms: item.video?.duration ? Number(item.video.duration) : undefined,
      file_size_bytes: item.size,
      thumbnail_url: item["@microsoft.graph.downloadUrl"] ?? undefined,
      preview_url: item["@microsoft.graph.downloadUrl"] ?? undefined,
      provider_url: item.webUrl ?? undefined,
      raw: { parentReference: item.parentReference ?? null },
    };
  }

  async function list(url: string): Promise<{ items: AssetRecord[]; deleted: string[]; nextCursor: string | null }> {
    const json = await call(url);
    const items = (json.value ?? []).map(mapItem).filter(Boolean) as AssetRecord[];
    const deleted = (json.value ?? [])
      .filter((item: any) => item.deleted)
      .map((item: any) => item.id)
      .filter(Boolean);

    return {
      items,
      deleted,
      nextCursor: (json["@odata.nextLink"] as string | undefined) ?? (json["@odata.deltaLink"] as string | undefined) ?? null,
    };
  }

  return {
    capabilities: CAPS,
    getCapabilities: () => CAPS,
    authenticate: async () => { await getAccessToken(); },
    refreshToken: async () => { await getAccessToken(); },
    listAssets: async (cursor) => {
      const url = cursor ?? `${API}/me/drive/root/search(q='')?$top=100&select=id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,photo,video,image,@microsoft.graph.downloadUrl`;
      const page = await list(url);
      return { items: page.items, nextCursor: page.nextCursor } satisfies PageResult;
    },
    getDeltaChanges: async (cursor) => {
      const url = cursor ?? `${API}/me/drive/root/delta?$top=100&select=id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,photo,video,image,@microsoft.graph.downloadUrl,deleted`;
      const page = await list(url);
      return { items: page.items, deleted: page.deleted, nextCursor: page.nextCursor } satisfies DeltaResult;
    },
    getAssetMetadata: async (providerAssetId) => {
      const item = await call(`${API}/me/drive/items/${providerAssetId}?select=id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,photo,video,image,@microsoft.graph.downloadUrl`);
      const mapped = mapItem(item);
      if (!mapped) throw new Error("asset not supported");
      return mapped;
    },
    getThumbnail: async (providerAssetId) => {
      const item = await call(`${API}/me/drive/items/${providerAssetId}?select=@microsoft.graph.downloadUrl`);
      const url = item["@microsoft.graph.downloadUrl"] as string | undefined;
      if (!url) throw new Error("download url unavailable");
      return { url };
    },
    getPreview: async (providerAssetId) => {
      const item = await call(`${API}/me/drive/items/${providerAssetId}?select=@microsoft.graph.downloadUrl`);
      const url = item["@microsoft.graph.downloadUrl"] as string | undefined;
      if (!url) throw new Error("download url unavailable");
      return { url };
    },
    getOriginalAccessToken: async (providerAssetId) => {
      const item = await call(`${API}/me/drive/items/${providerAssetId}?select=@microsoft.graph.downloadUrl`);
      const url = item["@microsoft.graph.downloadUrl"] as string | undefined;
      return url ? { url, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() } : null;
    },
    listAlbums: async () => {
      try {
        const json = await call(`${API}/me/drive/root/children?$top=200&$select=id,name,folder`);
        const folders = (json.value ?? [])
          .filter((item: any) => !!item.folder)
          .map((item: any) => ({ id: item.id as string, name: item.name as string }));
        return [{ id: "root", name: "All of OneDrive (root)" }, ...folders];
      } catch {
        return [{ id: "root", name: "All of OneDrive (root)" }];
      }
    },
    disconnect: async () => {
      await supabase.from("source_accounts").update({ status: "disconnected" }).eq("id", ctx.source_account_id);
    },
    revoke: async () => {
      await supabase.from("source_tokens")
        .update({ access_token_encrypted: "", refresh_token_encrypted: null, expires_at: null })
        .eq("source_account_id", ctx.source_account_id);
      await supabase.from("source_accounts").update({ status: "disconnected" }).eq("id", ctx.source_account_id);
    },
  };
};
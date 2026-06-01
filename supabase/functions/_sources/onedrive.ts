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
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    avi: "video/x-msvideo",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    aac: "audio/aac",
    flac: "audio/flac",
    ogg: "audio/ogg",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    rtf: "application/rtf",
    csv: "text/csv",
    md: "text/markdown",
    json: "application/json",
    xml: "application/xml",
  };
  return map[ext];
}

function inferFileKind(name: string, mimeType?: string): "photo" | "video" | "document" | "audio" | "other" {
  const ext = name.split(".").pop()?.toLowerCase();
  const mime = mimeType ?? inferMimeType(name);
  if (mime?.startsWith("image/")) return "photo";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (ext && ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv", "zip", "json", "xml", "psd", "ai", "indd"].includes(ext)) {
    return "document";
  }
  return ext ? "other" : "document";
}

function isSupportedMedia(name: string, mimeType?: string): boolean {
  const kind = inferFileKind(name, mimeType);
  return kind === "photo" || kind === "video" || kind === "audio" || kind === "document";
}

export const onedriveFactory = (ctx: ConnectorContext, supabase: any): SourceConnector => {
  async function getSelectedFolders(): Promise<Array<{ id: string; name?: string }>> {
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
    if (!item.file && !item.photo && !item.video && !item.audio) return null;
    const mimeType = item.file?.mimeType ?? inferMimeType(item.name);
    if (!isSupportedMedia(item.name, mimeType)) return null;
    const kind = inferFileKind(item.name, mimeType);
    const mediaTypeOut: "image" | "video" | "audio" | "document" =
      kind === "photo" ? "image" : kind === "video" ? "video" : kind === "audio" ? "audio" : "document";
    return {
      provider_asset_id: item.id,
      media_type: mediaTypeOut,
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

  let listAssetsRef: (cursor: string | null) => Promise<PageResult>;

  const conn: SourceConnector = {
    capabilities: CAPS,
    getCapabilities: () => CAPS,
    authenticate: async () => { await getAccessToken(); },
    refreshToken: async () => { await getAccessToken(); },
    listAssets: async (cursor) => {
      const selectedFolders = await getSelectedFolders();
      const folderTargets = selectedFolders.length ? selectedFolders.map((item) => item.id).filter(Boolean) : ["root"];
      const state = cursor
        ? JSON.parse(cursor) as { folderIndex?: number; providerCursor?: string | null }
        : { folderIndex: 0, providerCursor: null };
      const folderIndex = Math.max(0, Math.min(folderTargets.length - 1, state.folderIndex ?? 0));
      const currentFolderId = folderTargets[folderIndex] ?? "root";
      const url = state.providerCursor
        ? state.providerCursor
        : currentFolderId === "root"
          ? `${API}/me/drive/root/search(q='')?$top=100&select=id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,photo,video,image,@microsoft.graph.downloadUrl`
          : `${API}/me/drive/items/${currentFolderId}/search(q='')?$top=100&select=id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,photo,video,image,@microsoft.graph.downloadUrl`;
      const page = await list(url);
      const nextCursor = page.nextCursor
        ? JSON.stringify({ folderIndex, providerCursor: page.nextCursor })
        : folderIndex < folderTargets.length - 1
          ? JSON.stringify({ folderIndex: folderIndex + 1, providerCursor: null })
          : null;
      return { items: page.items, nextCursor } satisfies PageResult;
    },
    getDeltaChanges: async (cursor) => {
      const selectedFolders = await getSelectedFolders();
      if (selectedFolders.length) {
        const page = await listAssetsRef(cursor);
        return { items: page.items, deleted: [], nextCursor: page.nextCursor } satisfies DeltaResult;
      }
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
    countSelectionStats: async () => {
      const selectedFolders = await getSelectedFolders();
      if (!selectedFolders.length) return { folder_count: 0, photo: 0, video: 0, document: 0, audio: 0, other: 0 };

      const stats = { folder_count: 0, photo: 0, video: 0, document: 0, audio: 0, other: 0 };
      const seenFolders = new Set<string>();
      const seenFiles = new Set<string>();

      for (const target of selectedFolders) {
        const rootId = target.id || "root";
        if (!seenFolders.has(rootId)) {
          seenFolders.add(rootId);
          stats.folder_count += 1;
        }

        let nextUrl: string | null = rootId === "root"
          ? `${API}/me/drive/root/search(q='')?$top=200&select=id,name,file,folder,audio,image,photo,video,parentReference`
          : `${API}/me/drive/items/${rootId}/search(q='')?$top=200&select=id,name,file,folder,audio,image,photo,video,parentReference`;
        let safety = 0;

        while (nextUrl) {
          const json = await call(nextUrl);
          for (const item of (json.value ?? [])) {
            if (item.folder) {
              const folderId = item.id as string | undefined;
              if (folderId && !seenFolders.has(folderId)) {
                seenFolders.add(folderId);
                stats.folder_count += 1;
              }
              continue;
            }
            if (!item.file && !item.photo && !item.video && !item.audio) continue;
            const fileId = (item.id ?? item.webUrl ?? item.name) as string;
            if (seenFiles.has(fileId)) continue;
            seenFiles.add(fileId);
            const kind = inferFileKind(item.name ?? fileId, item.file?.mimeType);
            stats[kind] += 1;
          }

          const candidate = (json["@odata.nextLink"] as string | undefined) ?? null;
          nextUrl = candidate;
          if (++safety > 1000) break;
        }
      }

      return stats;
    },
    listAlbums: async (parentId) => {
      try {
        const isRoot = !parentId || parentId === "root";
        const url = isRoot
          ? `${API}/me/drive/root/children?$top=200&$select=id,name,folder,parentReference`
          : `${API}/me/drive/items/${parentId}/children?$top=200&$select=id,name,folder,parentReference`;
        const json = await call(url);
        const folders = (json.value ?? [])
          .filter((item: any) => !!item.folder)
          .map((item: any) => ({
            id: item.id as string,
            name: item.name as string,
            path: `${item.parentReference?.path ?? "/drive/root:"}/${item.name}`.replace(/^.*root:/, "") || `/${item.name}`,
            has_children: true,
            selectable: true,
          }));
        return !parentId
          ? [{ id: "root", name: "All of OneDrive (root)", path: "/", has_children: true, selectable: true }, ...folders]
          : folders;
      } catch {
        return (!parentId || parentId === "root")
          ? [{ id: "root", name: "All of OneDrive (root)", path: "/", has_children: true, selectable: true }]
          : [];
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

  listAssetsRef = conn.listAssets;
  return conn;
};
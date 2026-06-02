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
  kind: "dropbox",
  authMethod: "oauth2",
  supportsDelta: false,
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

const API = "https://api.dropboxapi.com/2";
const DROPBOX_REQUEST_TIMEOUT_MS = 20_000;

function normalizeDropboxPath(path: string | null | undefined): string {
  if (!path || path === "/") return "";
  return path;
}

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

export const dropboxFactory = (ctx: ConnectorContext, supabase: any): SourceConnector => {
  async function getSelectedFolders(): Promise<Array<{ id: string; name?: string }>> {
    const { data } = await supabase.from("source_permissions")
      .select("scopes")
      .eq("source_account_id", ctx.source_account_id)
      .maybeSingle();
    const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
    const selected = scopes.find((entry: unknown) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "selected_containers") as { containers?: Array<{ id: string; name?: string }> } | undefined;
    return Array.isArray(selected?.containers) ? selected!.containers : [];
  }

  async function resolveFolderPath(target: { id: string; name?: string; path?: string }): Promise<string> {
    const rawPath = target.path ?? target.id;
    if (!rawPath) return "";
    if (rawPath === "/") return "";

    try {
      const meta = await call("/files/get_metadata", {
        path: rawPath,
        include_media_info: false,
      });
      const canonical = (meta?.path_lower ?? meta?.path_display ?? rawPath) as string;
      return canonical === "/" ? "" : canonical;
    } catch {
      return rawPath;
    }
  }

  async function getAccessToken(): Promise<string> {
    const { data, error } = await supabase.from("source_tokens")
      .select("access_token_encrypted, refresh_token_encrypted, expires_at")
      .eq("source_account_id", ctx.source_account_id)
      .single();
    if (error || !data) throw new ConnectorAuthError("source tokens not found");

    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now() + 60_000) {
      const clientId = Deno.env.get("DROPBOX_APP_KEY");
      const clientSecret = Deno.env.get("DROPBOX_APP_SECRET");
      if (!clientId || !clientSecret || !data.refresh_token_encrypted) {
        throw new ConnectorAuthError("oauth refresh creds missing");
      }

      const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
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
      const json = await res.json() as { access_token: string; expires_in?: number };
      await supabase.from("source_tokens").update({
        access_token_encrypted: json.access_token,
        expires_at: json.expires_in ? new Date(Date.now() + (json.expires_in - 60) * 1000).toISOString() : null,
      }).eq("source_account_id", ctx.source_account_id);
      return json.access_token;
    }

    return data.access_token_encrypted;
  }

  async function call(path: string, body: Record<string, unknown>): Promise<any> {
    const token = await getAccessToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DROPBOX_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ConnectorTransientError(`dropbox ${path} timed out after ${Math.round(DROPBOX_REQUEST_TIMEOUT_MS / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
    if (res.status === 401) throw new ConnectorAuthError("unauthorized", true);
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "30");
      throw new ConnectorRateLimitError("rate limited", retryAfter);
    }
    if (res.status >= 500) throw new ConnectorTransientError(`upstream ${res.status}`);
    if (!res.ok) throw new Error(`dropbox ${path} failed: ${res.status}`);
    return res.json();
  }

  async function getTemporaryLink(path: string): Promise<string | undefined> {
    const json = await call("/files/get_temporary_link", { path });
    return json.link as string | undefined;
  }

  async function mapEntry(entry: any): Promise<AssetRecord | null> {
    const name = entry.name as string;
    const mimeType = inferMimeType(name);
    if (!isSupportedMedia(name, mimeType)) return null;

    // Do NOT call getTemporaryLink here — that adds one HTTP round-trip per file
    // during listing and causes rate-limit hits (100 concurrent requests per page).
    // The path in provider_url is enough for later jobs (generateDerived,
    // normalizeMetadata) to call getOriginalAccessToken on-demand.
    const media = entry.media_info?.metadata ?? {};
    const kind = inferFileKind(name, mimeType);
    const mediaTypeOut: "image" | "video" | "audio" | "document" =
      kind === "photo" ? "image" : kind === "video" ? "video" : kind === "audio" ? "audio" : "document";
    return {
      provider_asset_id: entry.id,
      media_type: mediaTypeOut,
      mime_type: mimeType,
      capture_time: media.time_taken ?? entry.client_modified ?? entry.server_modified,
      upload_time: entry.server_modified ?? undefined,
      created_time: entry.client_modified ?? entry.server_modified,
      modified_time: entry.server_modified ?? undefined,
      width: media.dimensions?.width,
      height: media.dimensions?.height,
      file_size_bytes: entry.size,
      thumbnail_url: undefined, // fetched on-demand by generateDerived
      preview_url: undefined,   // fetched on-demand by generateDerived
      provider_url: entry.path_display ?? entry.path_lower,
      raw: { path_display: entry.path_display ?? null },
    };
  }

  async function getCanonicalFolderTargets(): Promise<string[]> {
    const selectedFolders = await getSelectedFolders();
    if (!selectedFolders.length) return [""];

    const canonicalTargets = await Promise.all(
      selectedFolders.map((item) => resolveFolderPath(item as { id: string; name?: string; path?: string })),
    );

    const unique = new Set<string>();
    for (const target of canonicalTargets) {
      const normalized = !target || target === "/" ? "" : target;
      unique.add(normalized);
    }

    const ordered = Array.from(unique).sort((a, b) => a.length - b.length || a.localeCompare(b));
    const pruned: string[] = [];
    for (const target of ordered) {
      const normalized = normalizeDropboxPath(target);
      const lower = normalized.toLowerCase();
      const covered = pruned.some((existing) => {
        const base = normalizeDropboxPath(existing).toLowerCase();
        return base === "" || lower === base || lower.startsWith(`${base}/`);
      });
      if (!covered) pruned.push(normalized);
    }

    return pruned.length ? pruned : [""];
  }

  async function list(cursor: string | null): Promise<{ items: AssetRecord[]; deleted: string[]; nextCursor: string | null }> {
    const folderTargets = await getCanonicalFolderTargets();

    const parsed = cursor
      ? JSON.parse(cursor) as { folderIndex?: number; currentPath?: string | null; providerCursor?: string | null; pendingPaths?: string[] }
      : { folderIndex: 0, currentPath: folderTargets[0] ?? "", providerCursor: null, pendingPaths: [] };
    const folderIndex = Math.max(0, Math.min(folderTargets.length - 1, parsed.folderIndex ?? 0));
    const currentPath = normalizeDropboxPath(parsed.currentPath ?? folderTargets[folderIndex] ?? "");
    const pendingPaths = Array.isArray(parsed.pendingPaths)
      ? parsed.pendingPaths
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeDropboxPath(value))
      : [];

    const json = parsed.providerCursor
      ? await call("/files/list_folder/continue", { cursor: parsed.providerCursor })
      : await call("/files/list_folder", {
        path: currentPath,
        recursive: false,
        include_deleted: true,
        // include_media_info: false — Dropbox's media_info extraction is
        // notoriously slow (often 30s–2min on 400+ file folders) and isn't
        // needed here. normalizeMetadata fetches real EXIF on-demand per
        // asset. Keeping this off keeps listing inside the Edge runtime
        // budget so the job actually completes.
        include_media_info: false,
        limit: 500,
      });

    const deleted = (json.entries ?? [])
      .filter((entry: any) => entry[".tag"] === "deleted")
      .map((entry: any) => entry.id)
      .filter(Boolean);

    const mapped = await Promise.all(
      (json.entries ?? [])
        .filter((entry: any) => entry[".tag"] === "file")
        .map((entry: any) => mapEntry(entry)),
    );

    enqueueUniquePaths(
      pendingPaths,
      (json.entries ?? [])
        .filter((entry: any) => entry[".tag"] === "folder")
        .map((entry: any) => entry.path_lower ?? entry.path_display ?? null),
    );

    // Compute the next folder to walk WITHOUT mutating pendingPaths when the
    // current folder still has more pages. Previously this shifted entries
    // off pendingPaths unconditionally and then persisted the mutated array
    // back into the cursor when has_more=true, silently dropping subfolders
    // and leaving many files unindexed.
    let consumedPending = 0;
    let nextFolderPath: string | null = null;
    for (let i = 0; i < pendingPaths.length; i++) {
      const candidate = normalizeDropboxPath(pendingPaths[i]);
      consumedPending = i + 1;
      if (candidate.toLowerCase() !== currentPath.toLowerCase()) {
        nextFolderPath = candidate;
        break;
      }
    }
    const remainingPending = nextFolderPath === null
      ? []
      : pendingPaths.slice(consumedPending);

    return {
      items: mapped.filter(Boolean) as AssetRecord[],
      deleted,
      nextCursor: json.has_more
        ? JSON.stringify({
          folderIndex,
          currentPath,
          providerCursor: json.cursor as string,
          pendingPaths,
        })
        : nextFolderPath !== null
          ? JSON.stringify({ folderIndex, currentPath: nextFolderPath, providerCursor: null, pendingPaths: remainingPending })
          : folderIndex < folderTargets.length - 1
            ? JSON.stringify({
              folderIndex: folderIndex + 1,
              currentPath: folderTargets[folderIndex + 1] ?? "",
              providerCursor: null,
              pendingPaths: [],
            })
            : null,
    };
  }

  return {
    capabilities: CAPS,
    getCapabilities: () => CAPS,
    authenticate: async () => { await getAccessToken(); },
    refreshToken: async () => { await getAccessToken(); },
    listAssets: async (cursor) => {
      const page = await list(cursor);
      return { items: page.items, nextCursor: page.nextCursor } satisfies PageResult;
    },
    getDeltaChanges: async (cursor) => {
      const page = await list(cursor);
      return { items: page.items, deleted: page.deleted, nextCursor: page.nextCursor } satisfies DeltaResult;
    },
    getAssetMetadata: async (providerAssetId) => {
      const meta = await call("/files/get_metadata", { path: providerAssetId, include_media_info: true });
      const mapped = await mapEntry(meta);
      if (!mapped) throw new Error("asset not supported");
      return mapped;
    },
    getThumbnail: async (providerAssetId) => {
      const url = await getTemporaryLink(providerAssetId);
      if (!url) throw new Error("temporary link unavailable");
      return { url };
    },
    getPreview: async (providerAssetId) => {
      const url = await getTemporaryLink(providerAssetId);
      if (!url) throw new Error("temporary link unavailable");
      return { url };
    },
    getOriginalAccessToken: async (providerAssetId) => {
      const url = await getTemporaryLink(providerAssetId);
      return url ? { url, expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() } : null;
    },
    countSelectionStats: async () => {
      const selectedFolders = await getSelectedFolders();
      if (!selectedFolders.length) return { folder_count: 0, photo: 0, video: 0, document: 0, audio: 0, other: 0 };

      const stats = { folder_count: 0, photo: 0, video: 0, document: 0, audio: 0, other: 0 };
      const seenFolders = new Set<string>();
      const seenFiles = new Set<string>();

      for (const target of selectedFolders) {
        const canonicalPath = await resolveFolderPath(target as { id: string; name?: string; path?: string });
        const rootPath = canonicalPath ? canonicalPath : "/";
        const rootKey = rootPath.toLowerCase();
        if (rootPath && !seenFolders.has(rootKey)) {
          seenFolders.add(rootKey);
          stats.folder_count += 1;
        }

        let json: any = await call("/files/list_folder", {
          path: rootPath === "/" ? "" : rootPath,
          recursive: true,
          include_deleted: false,
          include_media_info: false,
          limit: 2000,
        });
        let safety = 0;

        while (true) {
          for (const entry of (json.entries ?? [])) {
            if (entry[".tag"] === "folder") {
              const folderId = (entry.path_lower ?? entry.path_display ?? `/${entry.name}`) as string;
              const folderKey = folderId.toLowerCase();
              if (!seenFolders.has(folderKey)) {
                seenFolders.add(folderKey);
                stats.folder_count += 1;
              }
              continue;
            }
            if (entry[".tag"] !== "file") continue;
            const fileId = (entry.id ?? entry.path_lower ?? entry.path_display ?? entry.name) as string;
            if (seenFiles.has(fileId)) continue;
            seenFiles.add(fileId);
            const kind = inferFileKind(entry.name ?? fileId);
            stats[kind] += 1;
          }

          if (!json.has_more || !json.cursor) break;
          if (++safety > 1000) break;
          json = await call("/files/list_folder/continue", { cursor: json.cursor });
        }
      }

      return stats;
    },
    listAlbums: async (parentId) => {
      try {
        const path = !parentId || parentId === "/" ? "" : parentId;
        const folders: Array<{ id: string; name: string; path?: string; has_children?: boolean; selectable?: boolean }> = [];

        if (!parentId) {
          folders.push({
            id: "/",
            name: "All of Dropbox (root)",
            path: "/",
            has_children: true,
            selectable: true,
          });
        }

        let json: any = await call("/files/list_folder", {
          path,
          recursive: false,
          include_deleted: false,
          include_media_info: false,
          include_mounted_folders: true,
          include_non_downloadable_files: true,
          limit: 2000,
        });
        let safety = 0;
        while (true) {
          for (const e of (json.entries ?? [])) {
            if (e[".tag"] !== "folder") continue;
            const folderPath = (e.path_display ?? e.path_lower ?? `/${e.name}`) as string;
            folders.push({
              id: e.path_lower ?? folderPath,
              name: e.name,
              path: folderPath,
              has_children: true,
              selectable: true,
            });
          }
          if (!json.has_more || !json.cursor) break;
          if (++safety > 1000) break;
          json = await call("/files/list_folder/continue", { cursor: json.cursor });
        }

        folders.sort((a, b) => (a.path ?? a.id).localeCompare(b.path ?? b.id));
        return folders as any;
      } catch (err) {
        console.error("dropbox listAlbums failed", err);
        return !parentId || parentId === "/"
          ? [{ id: "/", name: "All of Dropbox (root)", path: "/", has_children: true, selectable: true } as any]
          : [];
      }
    },
    disconnect: async () => {
      await supabase.from("source_accounts").update({ status: "disconnected" }).eq("id", ctx.source_account_id);
    },
    revoke: async () => {
      try {
        await call("/auth/token/revoke", {});
      } catch {
        // best effort
      }
      await supabase.from("source_tokens")
        .update({ access_token_encrypted: "", refresh_token_encrypted: null, expires_at: null })
        .eq("source_account_id", ctx.source_account_id);
      await supabase.from("source_accounts").update({ status: "disconnected" }).eq("id", ctx.source_account_id);
    },
  };
};
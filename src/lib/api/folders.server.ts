import process from "node:process";

export type SourceFolder = {
  id: string;
  name: string;
  path?: string;
  depth?: number;
  parentId?: string;
};

const FALLBACK_SUPABASE_URL = "https://vohevknnbvpaooletyts.supabase.co";
const FALLBACK_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_8DJ7KPaQ8JdG9-ZOqa30uw_pkc4pLpX";

function env() {
  return {
    supabaseUrl: process.env.SUPABASE_URL ?? FALLBACK_SUPABASE_URL,
    publishableKey:
      process.env.SUPABASE_PUBLISHABLE_KEY ?? FALLBACK_SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  };
}

async function restJson<T>(
  path: string,
  init: RequestInit & { apikey: string; authorization: string },
): Promise<T> {
  const { supabaseUrl } = env();
  const res = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
      apikey: init.apikey,
      authorization: init.authorization,
    },
  });

  if (!res.ok) {
    throw new Error(`supabase ${path} ${res.status}`);
  }

  return (await res.json()) as T;
}

export async function assertSourceOwnership(accountId: string, bearer: string) {
  const { publishableKey } = env();
  const rows = await restJson<Array<{ id: string }>>(
    `/rest/v1/source_accounts?id=eq.${accountId}&select=id`,
    {
      method: "GET",
      apikey: publishableKey,
      authorization: `Bearer ${bearer}`,
    },
  );

  return rows[0] ?? null;
}

async function getTokens(accountId: string) {
  const { serviceRoleKey } = env();
  if (!serviceRoleKey) return null;

  const rows = await restJson<
    Array<{
      access_token_encrypted: string;
      refresh_token_encrypted: string | null;
      expires_at: string | null;
    }>
  >(
    `/rest/v1/source_tokens?source_account_id=eq.${accountId}&select=access_token_encrypted,refresh_token_encrypted,expires_at`,
    {
      method: "GET",
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    },
  );

  return rows[0] ?? null;
}

async function patchTokens(
  accountId: string,
  payload: {
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
    expires_at: string | null;
  },
) {
  const { serviceRoleKey } = env();
  if (!serviceRoleKey) return;

  await fetch(
    `${env().supabaseUrl}/rest/v1/source_tokens?source_account_id=eq.${accountId}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );
}

async function refreshAccessToken(
  accountId: string,
  providerKind: string,
  refreshToken: string,
): Promise<string | null> {
  const configs = {
    google_photos: {
      url: "https://oauth2.googleapis.com/token",
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
    dropbox: {
      url: "https://api.dropboxapi.com/oauth2/token",
      clientId: process.env.DROPBOX_APP_KEY,
      clientSecret: process.env.DROPBOX_APP_SECRET,
    },
    onedrive: {
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    },
  } as const;

  const config = configs[providerKind as keyof typeof configs];
  if (!config?.clientId || !config.clientSecret) return null;

  const res = await fetch(config.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  await patchTokens(accountId, {
    access_token_encrypted: data.access_token,
    refresh_token_encrypted: data.refresh_token ?? refreshToken,
    expires_at: data.expires_in
      ? new Date(Date.now() + (data.expires_in - 60) * 1000).toISOString()
      : null,
  });

  return data.access_token;
}

export async function getAccessTokenForSource(
  accountId: string,
  providerKind: string,
): Promise<string | null> {
  const tokenRow = await getTokens(accountId);
  if (!tokenRow?.access_token_encrypted) return null;

  if (
    tokenRow.expires_at &&
    new Date(tokenRow.expires_at).getTime() < Date.now() + 60_000 &&
    tokenRow.refresh_token_encrypted
  ) {
    const fresh = await refreshAccessToken(
      accountId,
      providerKind,
      tokenRow.refresh_token_encrypted,
    );
    if (fresh) return fresh;
  }

  return tokenRow.access_token_encrypted;
}

function sortFolders(folders: SourceFolder[]) {
  return folders.sort((a, b) => {
    const pathA = (a.path ?? a.name ?? a.id).toLowerCase();
    const pathB = (b.path ?? b.name ?? b.id).toLowerCase();
    return pathA.localeCompare(pathB);
  });
}

function makeDropboxFolder(
  entry: { name: string; path_lower?: string; path_display?: string },
): SourceFolder {
  const normalizedPath = entry.path_lower ?? entry.path_display ?? `/${entry.name}`;
  const path = entry.path_display ?? normalizedPath;
  const segments = normalizedPath.split("/").filter(Boolean);
  const parentSegments = segments.slice(0, -1);

  return {
    id: normalizedPath,
    name: entry.name,
    path,
    depth: segments.length,
    parentId: parentSegments.length ? `/${parentSegments.join("/")}` : "/",
  };
}

export async function listDropboxFolders(token: string): Promise<SourceFolder[]> {
  const folders = new Map<string, SourceFolder>();
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const res = await fetch(
      cursor
        ? "https://api.dropboxapi.com/2/files/list_folder/continue"
        : "https://api.dropboxapi.com/2/files/list_folder",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          cursor
            ? { cursor }
            : {
                path: "",
                recursive: true,
                include_deleted: false,
                limit: 2000,
              },
        ),
      },
    );

    if (!res.ok) break;

    const data = (await res.json()) as {
      entries?: Array<{
        ".tag": string;
        name: string;
        path_lower?: string;
        path_display?: string;
      }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const entry of data.entries ?? []) {
      if (entry[".tag"] !== "folder") continue;
      const folder = makeDropboxFolder(entry);
      folders.set(folder.id, folder);
    }

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return sortFolders([
    { id: "/", name: "All of Dropbox (root)", path: "/", depth: 0 },
    ...folders.values(),
  ]);
}

function normalizeOneDriveParentPath(parentPath?: string | null) {
  if (!parentPath) return "/";
  const marker = "root:";
  const idx = parentPath.indexOf(marker);
  if (idx === -1) return "/";
  const rest = parentPath.slice(idx + marker.length) || "/";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

function joinOneDrivePath(parentPath: string, name: string) {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

export async function listOneDriveFolders(token: string): Promise<SourceFolder[]> {
  const folders = new Map<string, SourceFolder>();
  let nextUrl:
    | string
    | null = `${"https://graph.microsoft.com/v1.0/me/drive/root/delta?$top=200&$select=id,name,folder,parentReference,deleted"}`;

  for (let page = 0; page < 40 && nextUrl; page += 1) {
    const res = await fetch(nextUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) break;

    const data = (await res.json()) as {
      value?: Array<{
        id: string;
        name: string;
        folder?: unknown;
        deleted?: unknown;
        parentReference?: { path?: string | null };
      }>;
      "@odata.nextLink"?: string;
    };

    for (const item of data.value ?? []) {
      if (!item.folder || item.deleted) continue;
      const parentPath = normalizeOneDriveParentPath(item.parentReference?.path);
      const path = joinOneDrivePath(parentPath, item.name);
      const depth = path.split("/").filter(Boolean).length;
      folders.set(item.id, {
        id: item.id,
        name: item.name,
        path,
        depth,
      });
    }

    nextUrl = data["@odata.nextLink"] ?? null;
  }

  return sortFolders([
    { id: "root", name: "All of OneDrive (root)", path: "/", depth: 0 },
    ...folders.values(),
  ]);
}

export async function listGoogleAlbums(token: string): Promise<SourceFolder[]> {
  const folders: SourceFolder[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 10; page += 1) {
    const url = new URL("https://photoslibrary.googleapis.com/v1/albums");
    url.searchParams.set("pageSize", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) break;

    const data = (await res.json()) as {
      albums?: Array<{ id: string; title?: string }>;
      nextPageToken?: string;
    };

    for (const album of data.albums ?? []) {
      const name = album.title ?? "(untitled album)";
      folders.push({ id: album.id, name, path: `/${name}`, depth: 0 });
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return sortFolders(folders);
}

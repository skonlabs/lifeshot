import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

type Folder = { id: string; name: string };
type Result =
  | { ok: true; folders: Folder[] }
  | { ok: false; reason: string };

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? "https://vohevknnbvpaooletyts.supabase.co";

function svcKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
}

async function sb<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = svcKey();
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`supabase ${path} ${res.status}`);
  return (await res.json()) as T;
}

async function getAccount(accountId: string, userBearer: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/source_accounts?id=eq.${accountId}&select=id,user_id,provider_id,provider:source_providers(kind)`,
    {
      headers: {
        apikey: svcKey() || userBearer,
        authorization: `Bearer ${userBearer}`,
        accept: "application/json",
      },
    },
  );
  if (!res.ok) throw new Error(`account lookup ${res.status}`);
  const rows = (await res.json()) as Array<{
    id: string;
    user_id: string;
    provider: { kind: string } | null;
  }>;
  return rows[0] ?? null;
}

async function getTokens(accountId: string) {
  if (!svcKey()) return null;
  const rows = await sb<
    Array<{
      access_token_encrypted: string;
      refresh_token_encrypted: string | null;
      expires_at: string | null;
    }>
  >(
    `/rest/v1/source_tokens?source_account_id=eq.${accountId}&select=access_token_encrypted,refresh_token_encrypted,expires_at`,
  );
  return rows[0] ?? null;
}

async function refresh(
  accountId: string,
  kind: string,
  refreshToken: string,
): Promise<string | null> {
  const cfg = {
    google_photos: {
      url: "https://oauth2.googleapis.com/token",
      idEnv: "GOOGLE_CLIENT_ID",
      secretEnv: "GOOGLE_CLIENT_SECRET",
    },
    dropbox: {
      url: "https://api.dropboxapi.com/oauth2/token",
      idEnv: "DROPBOX_APP_KEY",
      secretEnv: "DROPBOX_APP_SECRET",
    },
    onedrive: {
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      idEnv: "MICROSOFT_CLIENT_ID",
      secretEnv: "MICROSOFT_CLIENT_SECRET",
    },
  } as Record<string, { url: string; idEnv: string; secretEnv: string }>;
  const c = cfg[kind];
  if (!c) return null;
  const clientId = process.env[c.idEnv];
  const clientSecret = process.env[c.secretEnv];
  if (!clientId || !clientSecret) return null;
  const res = await fetch(c.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  await fetch(
    `${SUPABASE_URL}/rest/v1/source_tokens?source_account_id=eq.${accountId}`,
    {
      method: "PATCH",
      headers: {
        apikey: svcKey(),
        authorization: `Bearer ${svcKey()}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        access_token_encrypted: j.access_token,
        refresh_token_encrypted: j.refresh_token ?? refreshToken,
        expires_at: j.expires_in
          ? new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString()
          : null,
      }),
    },
  );
  return j.access_token;
}

async function accessTokenFor(
  accountId: string,
  kind: string,
): Promise<string | null> {
  const tok = await getTokens(accountId);
  if (!tok || !tok.access_token_encrypted) return null;
  if (
    tok.expires_at &&
    new Date(tok.expires_at).getTime() < Date.now() + 60_000 &&
    tok.refresh_token_encrypted
  ) {
    const fresh = await refresh(accountId, kind, tok.refresh_token_encrypted);
    if (fresh) return fresh;
  }
  return tok.access_token_encrypted;
}

async function listGooglePhotos(token: string): Promise<Folder[]> {
  const folders: Folder[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 5; i++) {
    const url = new URL("https://photoslibrary.googleapis.com/v1/albums");
    url.searchParams.set("pageSize", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) break;
    const j = (await r.json()) as {
      albums?: Array<{ id: string; title?: string }>;
      nextPageToken?: string;
    };
    for (const a of j.albums ?? []) {
      folders.push({ id: a.id, name: a.title ?? "(untitled album)" });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return folders;
}

async function listDropbox(token: string): Promise<Folder[]> {
  const r = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: "", recursive: false, limit: 200 }),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as {
    entries?: Array<{
      ".tag": string;
      name: string;
      path_lower?: string;
      path_display?: string;
    }>;
  };
  const folders = (j.entries ?? [])
    .filter((e) => e[".tag"] === "folder")
    .map((e) => ({
      id: e.path_lower ?? e.path_display ?? `/${e.name}`,
      name: e.name,
    }));
  return [{ id: "/", name: "All of Dropbox (root)" }, ...folders];
}

async function listOneDrive(token: string): Promise<Folder[]> {
  const r = await fetch(
    "https://graph.microsoft.com/v1.0/me/drive/root/children?$select=id,name,folder&$top=200",
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!r.ok) return [];
  const j = (await r.json()) as {
    value?: Array<{ id: string; name: string; folder?: unknown }>;
  };
  const folders = (j.value ?? [])
    .filter((e) => !!e.folder)
    .map((e) => ({ id: e.id, name: e.name }));
  return [{ id: "root", name: "OneDrive (root)" }, ...folders];
}

export const listSourceFolders = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accountId: z.string().uuid(),
      bearer: z.string().min(10),
    }),
  )
  .handler(async ({ data }): Promise<Result> => {
    try {
      const account = await getAccount(data.accountId, data.bearer);
      if (!account) return { ok: false, reason: "account_not_found" };
      const kind = account.provider?.kind ?? "";
      if (!["google_photos", "dropbox", "onedrive"].includes(kind)) {
        return { ok: false, reason: "provider_unsupported" };
      }
      if (!svcKey()) {
        return { ok: false, reason: "service_unavailable" };
      }
      const token = await accessTokenFor(account.id, kind);
      if (!token) return { ok: false, reason: "no_token" };
      let folders: Folder[] = [];
      if (kind === "google_photos") folders = await listGooglePhotos(token);
      else if (kind === "dropbox") folders = await listDropbox(token);
      else if (kind === "onedrive") folders = await listOneDrive(token);
      return { ok: true, folders };
    } catch (e) {
      console.error("listSourceFolders error", e);
      return { ok: false, reason: "internal_error" };
    }
  });
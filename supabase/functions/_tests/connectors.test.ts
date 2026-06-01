import { assertEquals } from "jsr:@std/assert@1";
import { SUPPORTED_PROVIDERS } from "../_sources/registry.ts";
import { dropboxFactory } from "../_sources/dropbox.ts";

Deno.test("all 11 providers registered", () => {
  assertEquals(SUPPORTED_PROVIDERS.length, 11);
  for (const p of ["google_photos","local_ios","local_android","export_import","dropbox","onedrive","nas","external_drive","desktop_folder","icloud","amazon_photos"]) {
    if (!SUPPORTED_PROVIDERS.includes(p as any)) throw new Error(`missing provider: ${p}`);
  }
});

Deno.test("dropbox listAssets canonicalizes selected folder paths before recursive sync", async () => {
  const originalFetch = globalThis.fetch;
  const listFolderBodies: Array<Record<string, unknown>> = [];

  const supabase = {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({
          data: table === "source_permissions"
            ? {
                scopes: [{
                  type: "selected_containers",
                  containers: [{ id: "/Parent Folder/Child Folder", name: "Child Folder" }],
                }],
              }
            : null,
          error: null,
        }),
        single: async () => ({
          data: table === "source_tokens"
            ? {
                access_token_encrypted: "token",
                refresh_token_encrypted: null,
                expires_at: null,
              }
            : null,
          error: table === "source_tokens" ? null : new Error(`unexpected table ${table}`),
        }),
      };
    },
  };

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (url === "https://api.dropboxapi.com/2/files/get_metadata") {
      return Response.json({ path_lower: "/parent folder/child folder" });
    }

    if (url === "https://api.dropboxapi.com/2/files/list_folder") {
      listFolderBodies.push(body ?? {});
      return Response.json({
        entries: [{
          ".tag": "file",
          id: "file_1",
          name: "photo.jpg",
          path_display: "/Parent Folder/Child Folder/photo.jpg",
          path_lower: "/parent folder/child folder/photo.jpg",
          size: 42,
          client_modified: "2026-01-01T00:00:00Z",
          server_modified: "2026-01-01T00:00:00Z",
          media_info: { metadata: { dimensions: { width: 100, height: 50 } } },
        }],
        has_more: false,
      });
    }

    if (url === "https://api.dropboxapi.com/2/files/get_temporary_link") {
      return Response.json({ link: "https://example.com/file.jpg" });
    }

    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const connector = dropboxFactory({
      source_account_id: "source_1",
      user_id: "user_1",
      provider_kind: "dropbox",
    }, supabase as any);

    const page = await connector.listAssets(null);

    assertEquals(listFolderBodies.length, 1);
    assertEquals(listFolderBodies[0]?.path, "/parent folder/child folder");
    assertEquals(page.items.length, 1);
    assertEquals(page.items[0]?.provider_asset_id, "file_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
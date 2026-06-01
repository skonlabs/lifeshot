import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  assertSourceOwnership,
  getAccessTokenForSource,
  listDropboxFolders,
  listGoogleAlbums,
  listOneDriveFolders,
  type SourceFolder,
} from "./folders.server";

type Result =
  | { ok: true; folders: SourceFolder[] }
  | { ok: false; reason: string };

export const listSourceFolders = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accountId: z.string().uuid(),
      providerKind: z.string().min(1),
      bearer: z.string().min(10),
    }),
  )
  .handler(async ({ data }): Promise<Result> => {
    try {
      const owned = await assertSourceOwnership(data.accountId, data.bearer);
      if (!owned) return { ok: false, reason: "account_not_found" };

      if (!["google_photos", "dropbox", "onedrive"].includes(data.providerKind)) {
        return { ok: false, reason: "provider_unsupported" };
      }

      const token = await getAccessTokenForSource(data.accountId, data.providerKind);
      if (!token) return { ok: false, reason: "no_token" };

      if (data.providerKind === "google_photos") {
        return { ok: true, folders: await listGoogleAlbums(token) };
      }

      if (data.providerKind === "dropbox") {
        return { ok: true, folders: await listDropboxFolders(token) };
      }

      return { ok: true, folders: await listOneDriveFolders(token) };
    } catch (error) {
      console.error("listSourceFolders error", error);
      return { ok: false, reason: "internal_error" };
    }
  });
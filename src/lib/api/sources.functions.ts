import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { providerCatalog, getConnector } from "@/packages/sources/registry";
import type { ProviderId } from "@/packages/sources/types";

/**
 * Source management server fns. Stubs for now — they don't yet read/write the
 * authenticated user's Supabase rows. That requires the requireSupabaseAuth
 * middleware which the user can wire when the schema is live in their project.
 */

export const listProviders = createServerFn({ method: "GET" }).handler(async () => {
  return { providers: providerCatalog };
});

export const startConnect = createServerFn({ method: "POST" })
  .inputValidator((input: { provider: ProviderId; returnTo?: string }) =>
    z
      .object({
        provider: z.enum([
          "google_photos",
          "dropbox",
          "onedrive",
          "ios_device",
          "android_device",
          "desktop_folder",
          "whatsapp_import",
          "fb_export",
          "ig_export",
        ]),
        returnTo: z.string().url().or(z.string().startsWith("/")).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const c = getConnector(data.provider);
    const result = await c.startOAuth("__current_user__", data.returnTo ?? "/app/sources");
    return result;
  });

export const enqueueSync = createServerFn({ method: "POST" })
  .inputValidator((input: { sourceAccountId: string; mode: "delta" | "full" }) =>
    z
      .object({
        sourceAccountId: z.string().uuid(),
        mode: z.enum(["delta", "full"]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // TODO: emit Inngest event 'sync.requested'
    return { queued: true, mode: data.mode, sourceAccountId: data.sourceAccountId };
  });

export const disconnectSource = createServerFn({ method: "POST" })
  .inputValidator((input: { sourceAccountId: string }) =>
    z.object({ sourceAccountId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    // TODO: revoke token + cascade Inngest job
    return { ok: true, sourceAccountId: data.sourceAccountId };
  });
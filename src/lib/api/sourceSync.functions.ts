import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

const FALLBACK_SUPABASE_URL = "https://vohevknnbvpaooletyts.supabase.co";
const FALLBACK_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_8DJ7KPaQ8JdG9-ZOqa30uw_pkc4pLpX";

export const forceSyncSource = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accountId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const authorization = getRequestHeader("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw new Error("Unauthorized");
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? FALLBACK_SUPABASE_URL;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? FALLBACK_SUPABASE_PUBLISHABLE_KEY;

    // Call the SECURITY DEFINER RPC as the authenticated user.
    // The RPC validates ownership and writes to job_queue / source_sync_jobs /
    // source_accounts / source_errors itself, so no service-role key is needed.
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/force_sync_source`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        apikey: publishableKey,
        authorization,
      },
      body: JSON.stringify({ _account_id: data.accountId }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `force_sync_source failed with ${response.status}`);
    }

    const jobId = (await response.json()) as string;
    return { job_id: jobId };
  });
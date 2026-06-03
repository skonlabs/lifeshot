import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

const FALLBACK_SUPABASE_URL = "https://vohevknnbvpaooletyts.supabase.co";
const FALLBACK_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_8DJ7KPaQ8JdG9-ZOqa30uw_pkc4pLpX";

type RestInit = RequestInit & {
  apikey: string;
  authorization: string;
  prefer?: string;
};

async function restRequest<T>(path: string, init: RestInit): Promise<T> {
  const supabaseUrl = process.env.SUPABASE_URL ?? FALLBACK_SUPABASE_URL;
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(init.prefer ? { prefer: init.prefer } : {}),
      ...(init.headers ?? {}),
      apikey: init.apikey,
      authorization: init.authorization,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${init.method ?? "GET"} ${path} failed with ${response.status}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

export const forceSyncSource = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accountId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const authorization = getRequestHeader("Authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw new Error("Unauthorized");
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? FALLBACK_SUPABASE_URL;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? FALLBACK_SUPABASE_PUBLISHABLE_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      throw new Error("Supabase service role key is not configured.");
    }

    const accountRows = await restRequest<Array<{ id: string; user_id: string }>>(
      `/rest/v1/source_accounts?id=eq.${data.accountId}&select=id,user_id&limit=1`,
      {
        method: "GET",
        apikey: publishableKey,
        authorization,
      },
    );

    const account = accountRows[0];
    if (!account) {
      throw new Error("Source account not found.");
    }

    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();

    await restRequest<null>(
      `/rest/v1/source_sync_cursors?source_account_id=eq.${data.accountId}`,
      {
        method: "DELETE",
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: "return=minimal",
      },
    );

    await restRequest<null>(
      "/rest/v1/job_queue",
      {
        method: "POST",
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: "return=minimal",
        body: JSON.stringify({
          id: jobId,
          user_id: account.user_id,
          job_name: "syncSource",
          payload: { source_account_id: data.accountId, mode: "initial", force: true },
          status: "pending",
          priority: 100,
          lane: "user",
          next_attempt_at: now,
          scheduled_at: now,
          idempotency_key: `force-sync:${data.accountId}:${jobId}`,
          max_attempts: 5,
        }),
      },
    );

    await restRequest<null>(
      "/rest/v1/source_sync_jobs?on_conflict=id",
      {
        method: "POST",
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: "resolution=merge-duplicates,return=minimal",
        body: JSON.stringify({
          id: jobId,
          source_account_id: data.accountId,
          kind: "initial",
          status: "pending",
          stats: { stage: "queued", discovered: 1, indexed: 0, force: true },
        }),
      },
    );

    try {
      await restRequest<null>(
        `/rest/v1/source_accounts?id=eq.${data.accountId}`,
        {
          method: "PATCH",
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          prefer: "return=minimal",
          body: JSON.stringify({ status: "pending", sync_cancel_requested_at: null }),
        },
      );
    } catch {
      await restRequest<null>(
        `/rest/v1/source_accounts?id=eq.${data.accountId}`,
        {
          method: "PATCH",
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          prefer: "return=minimal",
          body: JSON.stringify({ status: "pending" }),
        },
      );
    }

    await restRequest<null>(
      `/rest/v1/source_errors?source_account_id=eq.${data.accountId}&resolved=eq.false`,
      {
        method: "PATCH",
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: "return=minimal",
        body: JSON.stringify({ resolved: true }),
      },
    );

    try {
      await fetch(`${new URL(supabaseUrl).origin}/functions/v1/worker/drain`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({}),
      });
    } catch {
      // Best effort only. Cron will still pick up the queued job.
    }

    return { job_id: jobId };
  });
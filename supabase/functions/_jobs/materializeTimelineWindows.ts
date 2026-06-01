// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function materializeTimelineWindows(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, from, to } = ctx.payload as { user_id: string; from?: string; to?: string };
  if (!user_id) throw new Error("invalid: user_id");
  const t0 = from ?? new Date(Date.now() - 30 * 86400_000).toISOString();
  const t1 = to ?? new Date().toISOString();
  // Refresh materialized view scoped: in absence of partitioned MVs, just call a SQL function.
  const { error } = await sb.rpc("refresh_timeline_windows", { _user_id: user_id, _from: t0, _to: t1 });
  if (error && !/does not exist/i.test(error.message)) throw new Error(error.message);
  return { user_id, from: t0, to: t1 };
}
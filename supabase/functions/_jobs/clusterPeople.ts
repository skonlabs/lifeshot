import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function clusterPeople(ctx: JobContext): Promise<unknown> {
  // Stub: face clustering disabled by default. No-op for tests.
  const { user_id } = ctx.payload as { user_id: string };
  return { user_id, clustered: 0, note: "face clustering disabled" };
}
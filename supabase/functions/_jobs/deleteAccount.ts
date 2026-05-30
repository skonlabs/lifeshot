// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/** Two-phase delete: soft-mark, then cascade hard-delete after grace window. */
export async function deleteAccount(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, phase = "soft" } = ctx.payload as { user_id: string; phase?: "soft" | "hard" };
  if (!user_id) throw new Error("invalid: user_id");
  if (phase === "soft") {
    await sb.from("user_profiles").update({ deleted_at: new Date().toISOString(), status: "pending_deletion" }).eq("user_id", user_id);
    return { user_id, phase: "soft" };
  }
  // Hard delete cascades via FK on auth.users(id).
  const { error } = await sb.auth.admin.deleteUser(user_id);
  if (error) throw new Error(`auth.admin.deleteUser: ${error.message}`);
  return { user_id, phase: "hard" };
}
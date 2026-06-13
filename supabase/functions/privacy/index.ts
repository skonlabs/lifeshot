import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { getServiceClient } from "../_shared/clients.ts";
import { jobEnqueuer } from "../_shared/interfaces.ts";
import { cache } from "../_shared/cache.ts";
import { emitEvent } from "../_shared/observability.ts";

const ConsentIn = z.object({
  scope: z.enum(["ai_processing","face_recognition","thumbnail_caching","proxy_caching","location_processing","family_sharing","export"]),
  source_account_id: z.string().uuid().optional(),
  granted: z.boolean(),
}).strict();
const DeleteDerivedIn = z.object({
  scope: z.enum(["all","source","asset"]),
  target_id: z.string().uuid().optional(),
}).strict();
const DeleteAccountIn = z.object({ confirm: z.literal(true) }).strict();

const app = authed(createApi("/privacy/v1"));

app.post("/consent", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const body = await parseBody(c, ConsentIn);
  const { error } = await supa.from("consent_records").insert({
    user_id: uid, scope: body.scope, source_account_id: body.source_account_id ?? null,
    granted: body.granted,
    granted_at: body.granted ? new Date().toISOString() : null,
    revoked_at: !body.granted ? new Date().toISOString() : null,
  });
  if (error) throw new ApiError("internal", error.message);
  // Revoking AI/face consent deletes derived AI data immediately.
  if (!body.granted && (body.scope === "ai_processing" || body.scope === "face_recognition")) {
    const svc = getServiceClient();
    await svc.from("asset_ai_enrichment").delete().eq("user_id", uid);
    await svc.from("asset_faces").delete().eq("user_id", uid);
    await svc.from("people").delete().eq("user_id", uid);
  }
  emitEvent(c, "privacy.consent", { scope: body.scope, granted: body.granted });
  return c.json({ ok: true });
});

app.delete("/derived-data", async (c) => {
  const uid = c.get("userId");
  await enforceRateLimit(uid, "delete");
  const body = await parseBody(c, DeleteDerivedIn);
  // Delete derived AI artifacts inline (service-role).
  const svc = getServiceClient();
  let q = svc.from("asset_ai_enrichment").delete().eq("user_id", uid);
  if (body.scope === "asset" && body.target_id) q = q.eq("asset_id", body.target_id);
  await q;
  let fq = svc.from("asset_faces").delete().eq("user_id", uid);
  if (body.scope === "asset" && body.target_id) fq = fq.eq("asset_id", body.target_id);
  await fq;
  if (body.scope === "all") {
    await svc.from("people").delete().eq("user_id", uid);
  }
  await cache.invalidateUser(uid);
  emitEvent(c, "privacy.derived_delete", body);
  return c.json({ status: "completed" }, 202);
});

app.post("/export", async (c) => {
  const uid = c.get("userId");
  await enforceRateLimit(uid, "export");
  // service-role read for full export
  const svc = getServiceClient();
  // Run export RPC as a job (large payloads). Return job id; download link later.
  const job = await jobEnqueuer.enqueue("exportUserData",
    { user_id: uid }, { userId: uid, priority: 4 });
  // Also produce a small synchronous preview using export_user_data RPC
  const { data } = await svc.rpc("export_user_data");
  emitEvent(c, "privacy.export", {});
  return c.json({ job_id: job.id, status: "accepted", preview: data }, 202);
});

app.delete("/account", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "delete");
  await parseBody(c, DeleteAccountIn);
  // RPC runs the cascade as the user (security definer); audit rows are written inside.
  const { error } = await supa.rpc("delete_account");
  if (error) throw new ApiError("internal", error.message);
  await cache.invalidateUser(uid);
  emitEvent(c, "privacy.account_delete");
  return c.json({ status: "completed", operation_id: crypto.randomUUID() }, 202);
});

Deno.serve(app.fetch);

import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody } from "../_shared/validation.ts";
import { sendError, ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { emitEvent } from "../_shared/observability.ts";

const PatchMe = z.object({
  display_name: z.string().min(1).max(120).optional(),
  avatar_url: z.string().url().max(2048).optional(),
  locale: z.string().min(2).max(20).optional(),
  timezone: z.string().min(1).max(80).optional(),
}).strict();

const PatchPrivacy = z.object({
  ai_enabled: z.boolean().optional(),
  face_processing_enabled: z.boolean().optional(),
  default_visibility: z.enum(["private","family","public"]).optional(),
  per_source_overrides: z.record(z.unknown()).optional(),
}).strict();

const app = authed(createApi("/me/v1"));

app.get("/", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const [{ data: profile }, { data: fams }] = await Promise.all([
    supa.from("user_profiles").select("*").eq("user_id", uid).maybeSingle(),
    supa.from("family_members").select("family_id, role, families(name)").eq("user_id", uid),
  ]);
  emitEvent(c, "me.read");
  return c.json({
    user_id: uid,
    display_name: profile?.display_name ?? null,
    avatar_url: profile?.avatar_url ?? null,
    locale: profile?.locale ?? "en",
    timezone: profile?.timezone ?? "UTC",
    tier: profile?.tier ?? "free",
    email: c.get("userEmail"),
    families: (fams ?? []).map((m: any) => ({
      family_id: m.family_id, role: m.role,
      name: m.families?.name ?? "",
    })),
  });
});

app.patch("/", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const body = await parseBody(c, PatchMe);
  const { data, error } = await supa.from("user_profiles")
    .upsert({ user_id: uid, ...body }, { onConflict: "user_id" })
    .select().single();
  if (error) throw new ApiError("internal", error.message);
  emitEvent(c, "me.update");
  return c.json(data);
});

app.get("/privacy-settings", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const { data } = await supa.from("privacy_settings").select("*").eq("user_id", uid).maybeSingle();
  return c.json(data ?? {
    ai_enabled: false, face_processing_enabled: false,
    default_visibility: "private", per_source_overrides: {},
  });
});

app.patch("/privacy-settings", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const body = await parseBody(c, PatchPrivacy);
  const { data: prev } = await supa.from("privacy_settings").select("*").eq("user_id", uid).maybeSingle();
  const { data, error } = await supa.from("privacy_settings")
    .upsert({ user_id: uid, ...body }, { onConflict: "user_id" })
    .select().single();
  if (error) throw new ApiError("internal", error.message);
  // Consent bump when AI/face changes
  const aiChanged = body.ai_enabled !== undefined && body.ai_enabled !== prev?.ai_enabled;
  const faceChanged = body.face_processing_enabled !== undefined && body.face_processing_enabled !== prev?.face_processing_enabled;
  if (aiChanged) {
    await supa.from("consent_records").insert({
      user_id: uid, scope: "ai_processing", granted: body.ai_enabled,
      granted_at: body.ai_enabled ? new Date().toISOString() : null,
      revoked_at: !body.ai_enabled ? new Date().toISOString() : null,
    });
  }
  if (faceChanged) {
    await supa.from("consent_records").insert({
      user_id: uid, scope: "face_recognition", granted: body.face_processing_enabled,
      granted_at: body.face_processing_enabled ? new Date().toISOString() : null,
      revoked_at: !body.face_processing_enabled ? new Date().toISOString() : null,
    });
  }
  emitEvent(c, "me.privacy_update", { aiChanged, faceChanged });
  return c.json(data);
});

Deno.serve(app.fetch);

import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseParams } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { jobEnqueuer } from "../_shared/interfaces.ts";
import { emitEvent } from "../_shared/observability.ts";

const CreateIn = z.object({ name: z.string().min(1).max(120) }).strict();
const InviteIn = z.object({
  family_id: z.string().uuid(),
  email: z.string().email().max(255),
  role: z.enum(["owner","admin","member","child","guest"]).default("member"),
}).strict();
const PatchMemberIn = z.object({
  role: z.enum(["owner","admin","member","child","guest"]).optional(),
  status: z.enum(["active","suspended","removed"]).optional(),
}).strict();

const app = authed(createApi("/families/v1"));

app.post("/families", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const body = await parseBody(c, CreateIn);
  const { data: fam, error } = await supa.from("families")
    .insert({ owner_user_id: uid, name: body.name }).select().single();
  if (error) throw new ApiError("internal", error.message);
  const { error: mErr } = await supa.from("family_members").insert({
    family_id: fam.id, user_id: uid, role: "owner", status: "active",
  });
  if (mErr) throw new ApiError("internal", mErr.message);
  emitEvent(c, "families.create");
  return c.json({ family: fam });
});

app.post("/invite", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const body = await parseBody(c, InviteIn);
  // verify caller is owner/admin
  const { data: me } = await supa.from("family_members")
    .select("role").eq("family_id", body.family_id).eq("user_id", uid).maybeSingle();
  if (!me || !["owner","admin"].includes(me.role)) throw new ApiError("forbidden", "Owner/admin only");
  const token = crypto.randomUUID();
  const { data, error } = await supa.from("family_invitations").insert({
    family_id: body.family_id, email: body.email, role: body.role,
    token, expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    created_by: uid,
  }).select().single();
  if (error) throw new ApiError("internal", error.message);
  await jobEnqueuer.enqueue("sendInvitationEmail",
    { invitation_id: data!.id, email: body.email, token }, { userId: uid });
  return c.json({ invitation: { id: data!.id, email: data!.email, role: data!.role } });
});

app.get("/:id", async (c) => {
  const supa = c.get("supabase");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const [{ data: fam }, { data: members }] = await Promise.all([
    supa.from("families").select("*").eq("id", id).maybeSingle(),
    supa.from("family_members").select("*, profile:user_profiles!inner(display_name, avatar_url)").eq("family_id", id),
  ]);
  if (!fam) throw new ApiError("not_found", "Family not found");
  return c.json({ family: fam, members: members ?? [] });
});

app.patch("/:id/members/:member_id", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id, member_id } = parseParams(c, z.object({
    id: z.string().uuid(), member_id: z.string().uuid(),
  }));
  const body = await parseBody(c, PatchMemberIn);
  const { data: me } = await supa.from("family_members")
    .select("role").eq("family_id", id).eq("user_id", uid).maybeSingle();
  if (!me || !["owner","admin"].includes(me.role)) throw new ApiError("forbidden", "Owner/admin only");
  // Prevent removing last owner
  if (body.role && body.role !== "owner") {
    const { data: target } = await supa.from("family_members").select("role").eq("id", member_id).maybeSingle();
    if (target?.role === "owner") {
      const { count } = await supa.from("family_members")
        .select("id", { count: "exact", head: true }).eq("family_id", id).eq("role", "owner");
      if ((count ?? 0) <= 1) throw new ApiError("conflict", "Cannot demote the last owner");
    }
  }
  const { data, error } = await supa.from("family_members")
    .update(body).eq("id", member_id).eq("family_id", id).select().single();
  if (error) throw new ApiError("internal", error.message);
  await supa.from("audit_logs").insert({
    user_id: uid, action: "family.member_update", target_type: "family_member",
    target_id: member_id, meta: body,
  });
  return c.json({ member: data });
});

Deno.serve(app.fetch);

// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function dedupGroup(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { phash } = ctx.payload as { phash: string };
  if (!phash) throw new Error("invalid: phash");
  const { data: members } = await sb.from("assets")
    .select("id, file_size_bytes, capture_time").eq("perceptual_hash", phash).order("capture_time").limit(500);
  if (!members || members.length < 2) return { phash, members: members?.length ?? 0 };
  const canonical = members[0].id;
  const { data: grp } = await sb.from("asset_dedup_groups").upsert({
    phash, canonical_asset_id: canonical, member_count: members.length,
  }, { onConflict: "phash" }).select("id").single();
  if (grp) {
    await sb.from("assets")
      .update({ dedup_group_id: grp.id, duplicate_group_id: grp.id })
      .in("id", members.map((m) => m.id));
  }
  return { phash, canonical, members: members.length };
}
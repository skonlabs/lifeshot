// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * dedupGroup — groups duplicate assets together under a canonical record.
 *
 * Two dedup strategies are supported and both may be triggered in one call:
 *
 * 1. Exact dedup via sha256 content hash.  hashAsset enqueues with
 *    { sha256, asset_id } when it finds another asset sharing the same hash.
 *
 * 2. Perceptual dedup via phash.  embedAsset / future perceptual-hash jobs
 *    enqueue with { phash, asset_id } when visual similarity is detected.
 *
 * Both paths write to the canonical duplicate_groups / duplicate_group_members
 * tables and stamp assets.duplicate_group_id.  Neither path deletes anything;
 * the user decides what to do via the Duplicates UI.
 */
export async function dedupGroup(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const payload = ctx.payload as { sha256?: string; phash?: string; asset_id?: string };

  const results: Record<string, unknown> = {};

  // ── Exact dedup path ────────────────────────────────────────────────────────
  if (payload.sha256) {
    const sha256 = payload.sha256;
    const { data: members } = await sb
      .from("assets")
      .select("id, file_size_bytes, capture_time, quality_score")
      .eq("checksum_hash", sha256)
      .order("quality_score", { ascending: false })
      .limit(500);

    if (members && members.length >= 2) {
      // Pick the highest quality_score asset as canonical; fall back to oldest.
      const canonical = members[0].id;
      const userId = ctx.userId!;

      const { data: grp, error: grpErr } = await sb
        .from("duplicate_groups")
        .upsert({
          user_id: userId,
          signal: "sha256",
          signal_value: sha256,
          canonical_asset_id: canonical,
          member_count: members.length,
          confidence: 1.0,
          status: "open",
        }, { onConflict: "user_id,signal,signal_value" })
        .select("id")
        .single();

      if (!grpErr && grp) {
        // Upsert membership rows.
        await sb.from("duplicate_group_members").upsert(
          members.map((m: any) => ({
            group_id: grp.id,
            asset_id: m.id,
            match_type: "checksum" as const,
            score: 1.0,
            is_canonical: m.id === canonical,
          })),
          { onConflict: "group_id,asset_id" },
        );
        // Stamp assets.duplicate_group_id for fast JOIN in queries.
        await sb.from("assets")
          .update({ duplicate_group_id: grp.id })
          .in("id", members.map((m: any) => m.id));
      }
      results.sha256 = { canonical, members: members.length };
    } else {
      results.sha256 = { members: members?.length ?? 0 };
    }
  }

  // ── Perceptual dedup path ───────────────────────────────────────────────────
  if (payload.phash) {
    const phash = payload.phash;
    const { data: members } = await sb
      .from("assets")
      .select("id, file_size_bytes, capture_time, quality_score")
      .eq("perceptual_hash", phash)
      .order("quality_score", { ascending: false })
      .limit(500);

    if (members && members.length >= 2) {
      const canonical = members[0].id;
      const userId = ctx.userId!;

      const { data: grp, error: grpErr } = await sb
        .from("duplicate_groups")
        .upsert({
          user_id: userId,
          signal: "phash",
          signal_value: phash,
          canonical_asset_id: canonical,
          member_count: members.length,
          confidence: 0.92,
          status: "open",
        }, { onConflict: "user_id,signal,signal_value" })
        .select("id")
        .single();

      if (!grpErr && grp) {
        await sb.from("duplicate_group_members").upsert(
          members.map((m: any) => ({
            group_id: grp.id,
            asset_id: m.id,
            match_type: "perceptual" as const,
            score: 0.92,
            is_canonical: m.id === canonical,
          })),
          { onConflict: "group_id,asset_id" },
        );
        await sb.from("assets")
          .update({ duplicate_group_id: grp.id })
          .in("id", members.map((m: any) => m.id));
      }
      results.phash = { canonical, members: members.length };
    } else {
      results.phash = { members: members?.length ?? 0 };
    }
  }

  if (!payload.sha256 && !payload.phash) {
    throw new Error("invalid: payload must include sha256 or phash");
  }

  return results;
}

// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

import { rekognitionConfigured } from "../_ai/rekognition.ts";
import { checkFaceResetGuard } from "./faceResetGuard.ts";
import {
  analyzeAssetFaces,
  parseDetectedFaces,
  storeFaceResults,
} from "../_ai/face-pipeline.ts";
import { getConnector } from "../_sources/registry.ts";

export async function enrichAI(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id, sync_run_id, force_sync_run_id } = ctx.payload as {
    asset_id: string;
    sync_run_id?: string;
    force_sync_run_id?: string;
  };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { enqueueJob } = await import("../_pipeline/enqueuer.ts");

  const { data: asset, error: assetErr } = await sb
    .from("assets")
    .select("id, user_id, thumbnail_cache_key, proxy_cache_key, mime_type, media_type")
    .eq("id", asset_id)
    .maybeSingle();
  // Use a retryable error so the runner doesn't dead-letter on transient DB issues.
  // Legitimate "asset deleted" cases will exhaust max_attempts naturally.
  if (assetErr) throw new Error(`retryable: asset lookup failed: ${assetErr.message}`);
  if (!asset) throw new Error("retryable: asset not ready yet");

  // Videos cannot be processed by Rekognition IndexFaces (image-only API).
  // Store a minimal enrichment record and exit — face detection is skipped entirely.
  const isVideo = asset.media_type === "video" || (asset.mime_type ?? "").startsWith("video/");
  if (isVideo) {
    await sb.from("asset_ai_enrichment").upsert(
      { asset_id, user_id: asset.user_id, face_count: 0 },
      { onConflict: "asset_id", ignoreDuplicates: true },
    );
    return { asset_id, skipped: "video" };
  }

  const { data: privacy } = await sb
    .from("privacy_settings")
    .select("face_pipeline_reset_at")
    .eq("user_id", asset.user_id)
    .maybeSingle();
  const resetGuard = await checkFaceResetGuard(sb, {
    userId: asset.user_id,
    jobId: ctx.jobId,
    resetAt: privacy?.face_pipeline_reset_at ?? null,
  });
  if (!resetGuard.valid) {
    return { asset_id, skipped: resetGuard.reason };
  }

  // ── Resolve image URLs (original / preview / thumbnail) ────────────────────
  async function signDerivative(kind: "preview" | "thumb"): Promise<string | null> {
    const { data: mm } = await sb
      .from("asset_media_metadata")
      .select("preview_url, preview_storage_path, thumbnail_url, thumbnail_storage_path")
      .eq("asset_id", asset_id)
      .maybeSingle();
    // Prefer storage path (our bucket, long-lived signed URL) over direct provider
    // URL — provider URLs (Google Photos, Dropbox etc.) expire in ~1 hour and
    // cause "no fetchable image" errors when enrichAI runs after expiry.
    // _storage_path fields are always derived-bucket paths (generateDerived
    // no longer writes uploads-bucket paths to asset_media_metadata).
    const storagePath = kind === "preview" ? mm?.preview_storage_path : mm?.thumbnail_storage_path;
    if (storagePath) {
      const { data: signed } = await sb.storage.from(STORAGE_BUCKETS.derived).createSignedUrl(storagePath, 600);
      if (signed?.signedUrl) return signed.signedUrl;
    }
    const directUrl = kind === "preview" ? mm?.preview_url : mm?.thumbnail_url;
    if (directUrl && /^https?:\/\//.test(directUrl)) return directUrl;
    return null;
  }

  async function resolveKey(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (/^https?:\/\//.test(key)) return key;
    // Try derived bucket first (generated thumbnails/previews), then uploads
    // bucket (original device uploads). local_ios and export_import assets store
    // originals in the uploads bucket, not derived.
    for (const bucket of [STORAGE_BUCKETS.derived, STORAGE_BUCKETS.uploads]) {
      const { data: signed } = await sb.storage.from(bucket).createSignedUrl(key, 600);
      if (signed?.signedUrl) return signed.signedUrl;
    }
    return null;
  }

  const originalImageUrl  = await resolveKey(asset.proxy_cache_key);
  const previewImageUrl   = await signDerivative("preview");
  const thumbnailImageUrl = (await resolveKey(asset.thumbnail_cache_key)) ?? (await signDerivative("thumb"));

  const url = previewImageUrl ?? thumbnailImageUrl ?? originalImageUrl;
  if (!url) {
    await enqueueJob("generateDerived", {
      userId: ctx.userId,
      payload: { asset_id },
      idempotencyKey: `derived-retry:${asset_id}`,
    });
    throw new Error("retryable: no preview url available for AI enrichment");
  }

  // ── Ensure asset_ai_enrichment row exists before any processing ───────────
  // This upsert is intentionally minimal and runs unconditionally so that
  // every active asset always has a record — even if vision or face detection
  // fails. Subsequent upserts below fill in caption/tags/faces as they succeed.
  // Explicit face_count: null avoids inheriting a DEFAULT 0 from the schema
  // on databases where the nullable migration hasn't been applied yet.
  // ignoreDuplicates: true ensures an existing row (with real face_count) is
  // never overwritten by this bootstrap insert.
  await sb.from("asset_ai_enrichment").upsert(
    { asset_id, user_id: asset.user_id, face_count: null },
    { onConflict: "asset_id", ignoreDuplicates: true },
  );

  // ── Vision analysis (caption + tags + objects) ─────────────────────────────
  // TEMPORARILY DISABLED — uncomment to re-enable OpenAI vision calls.
  let caption = "";
  let tags: string[] = [];
  let visionError: string | null = null;
  void visionError; // suppress unused-variable lint

  // try {
  //   const capResult = await providers.ai.caption({ url });
  //   caption = capResult.caption;
  //   tags = capResult.tags ?? [];
  // } catch (e: any) {
  //   visionError = String(e?.message ?? e);
  //   console.error("enrichAI: vision failed", { asset_id, error: visionError });
  // }

  // ── Face detection & storage (face-pipeline.ts) ────────────────────────────
  //   1. analyzeAssetFaces   — Rekognition IndexFaces, raw face JSON
  //   2. parseDetectedFaces  — one parsed JSON object per face (with crop)
  //   5. storeFaceResults    — asset_ai_enrichment + asset_faces + people
  //      (applies qualifyFaceForPerson and findBestPersonMatch per face)
  if (!rekognitionConfigured()) {
    console.warn("enrichAI: Rekognition not configured — face detection skipped", { asset_id });
    // Write face_count=0 so NULL always means "not yet processed / needs re-run".
    await sb.from("asset_ai_enrichment").upsert(
      { asset_id, user_id: asset.user_id, face_count: 0 },
      { onConflict: "asset_id", ignoreDuplicates: true },
    );
  } else {
    // For face detection, prefer original → preview → thumbnail in that order.
    // Thumbnail is a last resort — small images reduce detection accuracy — so
    // when we fall back to thumbnail, also enqueue generateDerived to produce a
    // proper preview that the next sync will use instead.
    if (!previewImageUrl && !originalImageUrl) {
      await enqueueJob("generateDerived", {
        userId: ctx.userId,
        payload: { asset_id },
        idempotencyKey: `derived-face-wait:${asset_id}`,
      });
    }

    // Resolve a TRUE full-resolution original URL via the source connector
    // (e.g. Google Photos =d). Used only as the source bytes for face crop
    // generation — Rekognition detection still runs on the smaller preview.
    // Best-effort: any failure here silently falls back to today's behavior.
    let cropSourceUrl: string | null = null;
    try {
      const { data: ref } = await sb.from("asset_source_refs")
        .select("source_account_id, source_asset_id")
        .eq("asset_id", asset_id)
        .order("is_primary", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ref?.source_account_id && ref?.source_asset_id) {
        const { data: acct } = await sb.from("source_accounts")
          .select("provider_id, provider_kind")
          .eq("id", ref.source_account_id)
          .single();
        let providerKind: any = acct?.provider_kind;
        if (!providerKind && acct?.provider_id) {
          const { data: pr } = await sb.from("source_providers")
            .select("kind").eq("id", acct.provider_id).single();
          providerKind = pr?.kind;
        }
        // Skip connectors whose "original" already lives in our uploads bucket
        // (proxy_cache_key already points at the full-res file).
        if (providerKind && providerKind !== "local_ios" && providerKind !== "export_import") {
          const conn = getConnector(providerKind, {
            source_account_id: ref.source_account_id,
            user_id: asset.user_id,
            provider_kind: providerKind,
          }, sb);
          const token = await conn.getOriginalAccessToken(ref.source_asset_id).catch(() => null);
          if (token?.url) cropSourceUrl = token.url;
        }
      }
    } catch (e: any) {
      console.warn("enrichAI: hi-res crop source lookup failed (non-fatal)", {
        asset_id, error: String(e?.message ?? e),
      });
    }

    let analysis: Awaited<ReturnType<typeof analyzeAssetFaces>>;
    try {
      analysis = await analyzeAssetFaces({
        originalImageUrl,
        previewImageUrl,
        thumbnailImageUrl,
        cropSourceUrl,
        assetId: asset_id,
        userId: asset.user_id,
      });
    } catch (e: any) {
      // Signed URLs existed but all fetches returned non-OK (e.g. 404 — file missing
      // from storage). Kick generateDerived to rebuild the derivatives then retry.
      if (String(e?.message ?? e).includes("no fetchable image")) {
        await enqueueJob("generateDerived", {
          userId: ctx.userId,
          payload: { asset_id },
          idempotencyKey: `derived-missing:${asset_id}:${Math.floor(Date.now() / 300_000)}`,
        });
      }
      throw e;
    }

    if (analysis) {
      const rawFaces = analysis.faceRecords;
      console.log(`enrichAI: Rekognition returned ${rawFaces.length} face(s) for asset ${asset_id}`);

      const parsed = await parseDetectedFaces(analysis);
      const postParseResetGuard = await checkFaceResetGuard(sb, {
        userId: asset.user_id,
        jobId: ctx.jobId,
        resetAt: privacy?.face_pipeline_reset_at ?? null,
      });
      if (!postParseResetGuard.valid) {
        return { asset_id, skipped: postParseResetGuard.reason };
      }
      const stored = await storeFaceResults({
        analysis,
        faces: parsed,
        beforeWrite: async () => {
          const guard = await checkFaceResetGuard(sb, {
            userId: asset.user_id,
            jobId: ctx.jobId,
            resetAt: privacy?.face_pipeline_reset_at ?? null,
          });
          if (!guard.valid) throw new Error(`invalid: ${guard.reason}`);
        },
      });
      console.log(`enrichAI: stored ${stored.asset_faces} face row(s) to asset_faces for asset ${asset_id}`);

      // Always write face_count after Rekognition runs — NULL means "not yet scanned",
      // 0 means "scanned, no faces found". Only preserve raw faces when detected.
      const enrichmentUpdate: Record<string, unknown> = {
        asset_id,
        user_id:    asset.user_id,
        face_count: rawFaces.length,
      };
      if (rawFaces.length > 0) {
        enrichmentUpdate.faces = rawFaces;
      }
      const { error: facesUpsertErr } = await sb.from("asset_ai_enrichment").upsert(
        enrichmentUpdate,
        { onConflict: "asset_id" },
      );
      if (facesUpsertErr) {
        console.error("enrichAI: asset_ai_enrichment faces upsert failed", { asset_id, error: facesUpsertErr.message });
      }

      await sb.from("assets").update({ face_scanned_at: new Date().toISOString() }).eq("id", asset_id);
    }

    // Enqueue clusterPeople so the People page is updated promptly.
    // NOTE: we intentionally do NOT re-check the reset guard here. Face writes
    // are already committed above; skipping clusterPeople would leave asset_faces
    // rows that are never clustered into people. A reset clears people separately.
    // Use a 5-minute time-window key so clusterPeople re-enqueues throughout a
    // long force sync. A per-run key caused a race: the first enrichAI to
    // complete would enqueue clusterPeople, it would run and write a ledger
    // entry, then ALL remaining enrichAI completions found the ledger entry and
    // skipped re-enqueueing — so faces from later assets were never clustered.
    const fiveMinuteBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const reclusterScope = `${fiveMinuteBucket}`;

    await enqueueJob("clusterPeople", {
      userId: asset.user_id,
      payload: { user_id: asset.user_id, asset_id },
      idempotencyKey: `people:${asset.user_id}:${reclusterScope}`,
    });
  }

  // Vision error handling and caption/tags write are temporarily disabled
  // while OpenAI calls are commented out above. Re-enable both when vision is
  // turned back on.

  // await enqueueJob("indexSearchDocument", {
  //   userId: ctx.userId,
  //   payload: { asset_id },
  //   idempotencyKey: `index:${asset_id}`,
  // });

  return {
    asset_id,
    caption_len: caption.length,
    tags:        tags.length,
  };
}

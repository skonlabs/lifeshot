// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

import { rekognitionConfigured } from "../_ai/rekognition.ts";
import {
  analyzeAssetFaces,
  parseDetectedFaces,
  storeFaceResults,
} from "../_ai/face-pipeline.ts";

export async function enrichAI(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
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

  // ── Resolve image URLs (original / preview / thumbnail) ────────────────────
  async function signDerivative(kind: "preview" | "thumb"): Promise<string | null> {
    const { data: deriv } = await sb
      .from("asset_derivatives")
      .select("storage_path, storage_bucket")
      .eq("asset_id", asset_id)
      .eq("kind", kind)
      .maybeSingle();
    if (!deriv?.storage_path) return null;
    const { data: signed } = await sb.storage
      .from(deriv.storage_bucket)
      .createSignedUrl(deriv.storage_path, 600);
    return signed?.signedUrl ?? null;
  }

  async function resolveKey(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (/^https?:\/\//.test(key)) return key;
    const { data: signed } = await sb.storage
      .from(STORAGE_BUCKETS.derived)
      .createSignedUrl(key, 600);
    return signed?.signedUrl ?? null;
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

  // ── Vision analysis (caption + tags + objects) ─────────────────────────────
  let caption = "";
  let tags: string[] = [];
  let objects: Array<{ label: string; score: number }> = [];
  let visionError: string | null = null;

  try {
    const [capResult, objResult] = await Promise.all([
      providers.ai.caption({ url }),
      providers.ai.detectObjects({ url }),
    ]);
    caption = capResult.caption;
    tags = capResult.tags ?? [];
    objects = objResult ?? [];
  } catch (e: any) {
    visionError = String(e?.message ?? e);
    console.error("enrichAI: vision failed", { asset_id, error: visionError });
  }

  // ── Face detection & storage (face-pipeline.ts) ────────────────────────────
  //   1. analyzeAssetFaces   — Rekognition IndexFaces, raw face JSON
  //   2. parseDetectedFaces  — one parsed JSON object per face (with crop)
  //   5. storeFaceResults    — asset_ai_enrichment + asset_faces + people
  //      (applies qualifyFaceForPerson and findBestPersonMatch per face)
  let rawFaces: Array<Record<string, unknown>> = [];

  if (!rekognitionConfigured()) {
    console.warn("enrichAI: Rekognition not configured — face detection skipped", { asset_id });
  } else {
    const analysis = await analyzeAssetFaces({
      originalImageUrl,
      previewImageUrl,
      thumbnailImageUrl,
      assetId: asset_id,
      userId: asset.user_id,
    });

    if (analysis) {
      rawFaces = analysis.faceRecords;
      console.log(`enrichAI: Rekognition returned ${rawFaces.length} face(s) for asset ${asset_id}`);

      const parsed = await parseDetectedFaces(analysis);
      const stored = await storeFaceResults({ analysis, faces: parsed });
      console.log(`enrichAI: stored ${stored.asset_faces} face row(s) to asset_faces for asset ${asset_id}`);
    }

    await sb.from("assets").update({ face_scanned_at: new Date().toISOString() }).eq("id", asset_id);

    // Enqueue clusterPeople so the People page is updated promptly.
    // clusterPeople is the sole writer to the people table — running it here
    // rather than in storeFaceResults ensures a single serialised per-user
    // write path, eliminating race conditions from parallel enrichAI jobs.
    await enqueueJob("clusterPeople", {
      userId: ctx.userId,
      payload: { user_id: asset.user_id },
      idempotencyKey: `people:${asset.user_id}:${new Date().toISOString().slice(0, 13)}`,
    });
  }

  // ── Persist caption/tags/objects (faces written by storeFaceResults) ───────
  const { error: upsertErr } = await sb.from("asset_ai_enrichment").upsert({
    asset_id,
    user_id: asset.user_id,
    caption,
    tags,
    objects,
    faces: rawFaces,
    rekognition_response: rawFaces.length > 0 ? rawFaces : null,
    enriched_at: !visionError ? new Date().toISOString() : null,
  }, { onConflict: "asset_id" });
  if (upsertErr) {
    console.error("enrichAI: asset_ai_enrichment upsert failed", { asset_id, error: upsertErr.message });
  }

  await enqueueJob("indexSearchDocument", {
    userId: ctx.userId,
    payload: { asset_id },
    idempotencyKey: `index:${asset_id}`,
  });

  if (visionError) {
    // Permanent vision failures (unsupported/corrupt image formats, persistent
    // circuit-breaker trips) must NOT spin forever — mark non-retryable.
    const permanent = /invalid_image_format|unsupported image|image_parse_error|invalid image|circuit breaker open/i.test(visionError);
    if (permanent) {
      console.warn("enrichAI: permanent vision failure — not retrying", { asset_id, visionError });
      return { asset_id, caption_len: 0, tags: 0, objects: 0, faces: rawFaces.length, vision_skipped: visionError.slice(0, 200) };
    }
    throw new Error(`retryable: AI enrichment failed for ${asset_id}: ${visionError}`);
  }

  return {
    asset_id,
    caption_len: caption.length,
    tags: tags.length,
    objects: objects.length,
    faces: rawFaces.length,
  };
}

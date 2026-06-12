// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

import { detectFaces } from "../_ai/face-detector.ts";
import { rekognitionConfigured } from "../_ai/rekognition.ts";

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

  // ── Resolve image URL ──────────────────────────────────────────────────────
  let url: string | null = null;

  const rawKey = asset.proxy_cache_key ?? asset.thumbnail_cache_key ?? null;
  if (rawKey && /^https?:\/\//.test(rawKey)) {
    url = rawKey;
  }

  if (!url) {
    for (const kind of ["preview", "thumb"]) {
      const { data: deriv } = await sb
        .from("asset_derivatives")
        .select("storage_path, storage_bucket")
        .eq("asset_id", asset_id)
        .eq("kind", kind)
        .maybeSingle();
      if (deriv?.storage_path) {
        const { data: signed } = await sb.storage
          .from(deriv.storage_bucket)
          .createSignedUrl(deriv.storage_path, 600);
        if (signed?.signedUrl) { url = signed.signedUrl; break; }
      }
    }
  }

  if (!url && rawKey && !/^https?:\/\//.test(rawKey)) {
    const { data: signed } = await sb.storage
      .from(STORAGE_BUCKETS.derived)
      .createSignedUrl(rawKey, 600);
    url = signed?.signedUrl ?? null;
  }

  if (!url) {
    await enqueueJob("generateDerived", {
      userId: ctx.userId,
      payload: { asset_id },
      idempotencyKey: `derived-retry:${asset_id}`,
    });
    throw new Error("retryable: no preview url available for AI enrichment");
  }

  console.log(`enrichAI: resolved image url for asset ${asset_id}`);

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

  // ── Face detection ─────────────────────────────────────────────────────────
  // Call Rekognition IndexFaces (qualityFilter=NONE) → store ALL detected faces
  // in asset_faces. No privacy gating here — that's handled at the app layer.
  // clusterPeople applies quality gate (FaceOccluded=false, confidence≥90%) when
  // writing to the people table.
  let faces: Array<Record<string, unknown>> = [];

  if (!rekognitionConfigured()) {
    console.warn("enrichAI: Rekognition not configured — face detection skipped", { asset_id });
  } else {
    console.log(`enrichAI: calling detectFaces for asset ${asset_id}`);

    let detected: Awaited<ReturnType<typeof detectFaces>> = [];
    try {
      detected = await detectFaces({ imageUrl: url, userId: asset.user_id, assetId: asset_id });
      console.log(`enrichAI: Rekognition returned ${detected.length} face(s) for asset ${asset_id}`);
    } catch (e: any) {
      console.error("enrichAI: detectFaces threw", { asset_id, error: String(e?.message ?? e) });
    }

    if (detected.length > 0) {
      faces = detected.map((f) => ({
        bbox:       f.bbox,
        score:      f.confidence,
        face_id:    f.face_id,
        face_crop:  f.face_crop,
        attributes: f.attributes,
      }));

      // Write all detected faces to asset_faces — delete old rows first for idempotency.
      const { error: delErr } = await sb.from("asset_faces").delete().eq("asset_id", asset_id);
      if (delErr) {
        console.error("enrichAI: asset_faces delete failed", { asset_id, error: delErr.message });
        throw new Error(`asset_faces delete failed: ${delErr.message}`);
      }

      const { error: insErr } = await sb.from("asset_faces").insert(
        detected.map((f) => ({
          asset_id,
          user_id:    asset.user_id,
          face_id:    f.face_id ?? null,
          bbox:       f.bbox ?? null,
          confidence: f.confidence ?? null,
          face_crop:  f.face_crop ?? null,
          attributes: f.attributes ?? null,
        })),
      );
      if (insErr) {
        console.error("enrichAI: asset_faces insert failed", { asset_id, error: insErr.message });
        throw new Error(`asset_faces insert failed: ${insErr.message}`);
      }
      console.log(`enrichAI: wrote ${detected.length} row(s) to asset_faces for asset ${asset_id}`);
    } else {
      console.log(`enrichAI: no faces detected for asset ${asset_id} — asset_faces not written`);
    }

    // Mark asset as face-scanned and enqueue clustering.
    await sb.from("assets").update({ face_scanned_at: new Date().toISOString() }).eq("id", asset_id);

    if (detected.length > 0) {
      await enqueueJob("clusterPeople", {
        userId: ctx.userId,
        payload: { user_id: asset.user_id, asset_id },
        idempotencyKey: `people-cluster:${asset_id}`,
      });
    }
  }

  // ── Persist AI enrichment ──────────────────────────────────────────────────
  const { error: upsertErr } = await sb.from("asset_ai_enrichment").upsert({
    asset_id,
    user_id: asset.user_id,
    caption,
    tags,
    objects,
    faces,
    rekognition_response: faces.length > 0 ? faces : null,
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
      return { asset_id, caption_len: 0, tags: 0, objects: 0, faces: faces.length, vision_skipped: visionError.slice(0, 200) };
    }
    throw new Error(`retryable: AI enrichment failed for ${asset_id}: ${visionError}`);
  }

  return {
    asset_id,
    caption_len: caption.length,
    tags: tags.length,
    objects: objects.length,
    faces: faces.length,
  };
}

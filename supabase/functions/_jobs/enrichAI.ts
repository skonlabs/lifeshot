// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

import { detectFaces } from "../_ai/face-detector.ts";
import { rekognitionConfigured } from "../_ai/rekognition.ts";

/**
 * enrichAI — vision analysis + face detection for one asset.
 *
 * Face pipeline:
 *   1. detectFaces() → IndexFaces (qualityFilter=NONE) → all faces detected by Rekognition
 *   2. Every detected face is written to asset_faces (no quality filter — raw data)
 *   3. Full attributes JSON stored in asset_ai_enrichment.rekognition_response
 *   4. clusterPeople job is enqueued → applies quality gate (FaceOccluded=false, confidence≥90%)
 *      and writes qualifying faces to the people table
 *
 * Gate: face detection only runs when privacy_settings.face_processing_enabled = true
 * AND AWS Rekognition is configured. Both conditions must be true.
 */
export async function enrichAI(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { enqueueJob } = await import("../_pipeline/enqueuer.ts");

  // Consent gate — respect user's AI processing preference.
  const { data: prof } = await sb
    .from("user_profiles")
    .select("ai_processing_enabled")
    .eq("user_id", ctx.userId!)
    .maybeSingle();
  if (prof && prof.ai_processing_enabled === false) return { skipped: "consent" };

  const { data: asset } = await sb
    .from("assets")
    .select("id, user_id, thumbnail_cache_key, proxy_cache_key, mime_type, media_type")
    .eq("id", asset_id)
    .single();
  if (!asset) throw new Error("not found: asset");

  // Resolve a publicly-accessible URL for the asset image.
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

  let caption = "";
  let tags: string[] = [];
  let objects: Array<{ label: string; score: number }> = [];
  let error: string | null = null;

  try {
    const [capResult, objResult] = await Promise.all([
      providers.ai.caption({ url }),
      providers.ai.detectObjects({ url }),
    ]);
    caption = capResult.caption;
    tags = capResult.tags ?? [];
    objects = objResult ?? [];
  } catch (e: any) {
    error = String(e?.message ?? e);
    console.error("enrichAI vision failed", { asset_id, error });
  }

  // ── Face detection ────────────────────────────────────────────────────────
  // Requires face_processing_enabled = true in privacy_settings AND AWS creds.
  // All detected faces → asset_faces (no quality filter here).
  // clusterPeople applies quality gate before writing to people.
  let faces: Array<Record<string, unknown>> = [];
  let faceDetectionAttempted = false;

  if (!rekognitionConfigured()) {
    console.warn("enrichAI: Rekognition not configured — face detection skipped", { asset_id });
  } else {
    const { data: privacy, error: privacyErr } = await sb
      .from("privacy_settings")
      .select("face_processing_enabled")
      .eq("user_id", asset.user_id)
      .maybeSingle();

    if (privacyErr) {
      console.error("enrichAI: privacy_settings query failed", { asset_id, error: privacyErr.message });
    } else if (!privacy) {
      console.warn("enrichAI: no privacy_settings row for user — face detection skipped. " +
        "Run migration to enable face processing or set face_processing_enabled=true.", { asset_id, user_id: asset.user_id });
    } else if (!privacy.face_processing_enabled) {
      console.warn("enrichAI: face_processing_enabled=false for user — face detection skipped", { asset_id, user_id: asset.user_id });
    } else {
      // ── Face detection enabled ──────────────────────────────────────────
      faceDetectionAttempted = true;
      let detected: Awaited<ReturnType<typeof detectFaces>> = [];

      try {
        detected = await detectFaces({ imageUrl: url, userId: asset.user_id, assetId: asset_id });
        console.log(`enrichAI: detected ${detected.length} face(s)`, { asset_id });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error("enrichAI: detectFaces threw", { asset_id, error: msg });
        faceDetectionAttempted = false;
      }

      if (faceDetectionAttempted) {
        faces = detected.map((f) => ({
          bbox:       f.bbox,
          score:      f.confidence,   // 0-1
          face_id:    f.face_id,
          face_crop:  f.face_crop,
          attributes: f.attributes,   // full FaceDetail JSON
        }));

        // Write ALL detected faces to asset_faces. Errors here are FATAL
        // (not swallowed) so missing data surfaces immediately.
        const { error: delErr } = await sb.from("asset_faces").delete().eq("asset_id", asset_id);
        if (delErr) {
          console.error("enrichAI: asset_faces delete failed — is the migration applied?", { asset_id, error: delErr.message });
          // Throw so the job retries after the migration is applied.
          throw new Error(`asset_faces delete failed: ${delErr.message}`);
        }

        if (detected.length > 0) {
          const { error: insErr } = await sb.from("asset_faces").insert(
            detected.map((f) => ({
              asset_id,
              user_id:    asset.user_id,
              face_id:    f.face_id ?? null,
              bbox:       f.bbox ?? null,
              confidence: f.confidence ?? null,   // 0-1
              face_crop:  f.face_crop ?? null,
              attributes: f.attributes ?? null,
            })),
          );
          if (insErr) {
            console.error("enrichAI: asset_faces insert failed", { asset_id, error: insErr.message });
            throw new Error(`asset_faces insert failed: ${insErr.message}`);
          }
          console.log(`enrichAI: wrote ${detected.length} row(s) to asset_faces`, { asset_id });
        }
      }
    }
  }

  // Persist AI enrichment.
  const { error: upsertErr } = await sb.from("asset_ai_enrichment").upsert({
    asset_id,
    user_id: asset.user_id,
    caption,
    tags,
    objects,
    faces,
    rekognition_response: faceDetectionAttempted && faces.length > 0 ? faces : null,
    enriched_at: !error ? new Date().toISOString() : null,
  }, { onConflict: "asset_id" });
  if (upsertErr) {
    console.error("enrichAI: asset_ai_enrichment upsert failed", { asset_id, error: upsertErr.message });
  }

  if (faceDetectionAttempted) {
    await sb.from("assets").update({ face_scanned_at: new Date().toISOString() }).eq("id", asset_id);

    if (faces.length > 0) {
      await enqueueJob("clusterPeople", {
        userId: ctx.userId,
        payload: { user_id: asset.user_id, asset_id },
        idempotencyKey: `people-cluster:${asset_id}`,
      });
    }
  }

  if (error) {
    throw new Error(`retryable: AI enrichment failed for ${asset_id}: ${error}`);
  }

  await enqueueJob("indexSearchDocument", {
    userId: ctx.userId,
    payload: { asset_id },
    idempotencyKey: `index:${asset_id}`,
  });

  return {
    asset_id,
    caption_len: caption.length,
    tags: tags.length,
    objects: objects.length,
    faces: faces.length,
    face_detection_attempted: faceDetectionAttempted,
    error,
  };
}

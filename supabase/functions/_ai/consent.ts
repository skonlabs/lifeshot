// deno-lint-ignore-file no-explicit-any
/**
 * Consent + privacy gate. Every AI call MUST run through here.
 * - Checks global ai_enabled on privacy_settings.
 * - Checks per-source override (per_source_overrides).
 * - face/biometric work requires face_processing_enabled.
 * - Records that processing happened against consent_records.
 */
import { serviceClient } from "../_pipeline/clients.ts";

export type ConsentScope = "ai_processing" | "face_processing";

export interface ConsentDecision {
  allowed: boolean;
  reason?: string;
  aiEnabled: boolean;
  faceEnabled: boolean;
}

export async function checkConsent(opts: {
  userId: string;
  scope?: ConsentScope;          // default 'ai_processing'
  sourceAccountId?: string | null;
}): Promise<ConsentDecision> {
  const sb = serviceClient();
  const { data: ps } = await sb.from("privacy_settings")
    .select("ai_enabled, face_processing_enabled, per_source_overrides")
    .eq("user_id", opts.userId)
    .maybeSingle();
  const ai = !!(ps?.ai_enabled);
  const face = !!(ps?.face_processing_enabled);
  if (!ai) return { allowed: false, reason: "ai_disabled", aiEnabled: ai, faceEnabled: face };
  if (opts.scope === "face_processing" && !face) {
    return { allowed: false, reason: "face_disabled", aiEnabled: ai, faceEnabled: face };
  }
  if (opts.sourceAccountId) {
    const over = (ps?.per_source_overrides ?? {}) as Record<string, { ai_enabled?: boolean }>;
    const s = over[opts.sourceAccountId];
    if (s && s.ai_enabled === false) {
      return { allowed: false, reason: "source_ai_disabled", aiEnabled: ai, faceEnabled: face };
    }
  }
  return { allowed: true, aiEnabled: ai, faceEnabled: face };
}

export async function recordAIProcessing(opts: {
  userId: string;
  scope?: ConsentScope;
  sourceAccountId?: string | null;
}): Promise<void> {
  const sb = serviceClient();
  await sb.from("consent_records").insert({
    user_id: opts.userId,
    scope: opts.scope ?? "ai_processing",
    source_account_id: opts.sourceAccountId ?? null,
    granted: true,
    granted_at: new Date().toISOString(),
  }).select("id").maybeSingle();
}

/** Purge derived AI artifacts for a scope. */
export async function deleteDerivedAI(opts: {
  userId?: string;
  sourceAccountId?: string;
  assetId?: string;
}): Promise<{ captions: number; labels: number; ocr: number; embeddings: number; ai_enrichment: number; vision_cache: number; sensitive: number }> {
  const sb = serviceClient();
  // Resolve asset_ids in scope.
  let assetIds: string[] = [];
  if (opts.assetId) {
    assetIds = [opts.assetId];
  } else if (opts.sourceAccountId || opts.userId) {
    let q = sb.from("assets").select("id");
    if (opts.userId) q = q.eq("user_id", opts.userId);
    if (opts.sourceAccountId) {
      const refs = await sb.from("asset_source_refs").select("asset_id").eq("source_account_id", opts.sourceAccountId);
      const ids = (refs.data ?? []).map((r: any) => r.asset_id);
      q = q.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    }
    const { data } = await q.limit(50000);
    assetIds = (data ?? []).map((r: any) => r.id);
  }
  if (assetIds.length === 0) {
    return { ocr: 0, ai_enrichment: 0 };
  }
  // asset_ocr was merged into asset_ai_enrichment in the B-NUKE consolidation.
  // Clearing the OCR columns and deleting enrichment rows covers both data sets.
  const clearOcr = await sb.from("asset_ai_enrichment").update({
    ocr_text: null, ocr_lang: null, ocr_confidence: null, ocr_boxes: null, ocr_at: null,
  }).in("asset_id", assetIds);
  const delEnrich = await sb.from("asset_ai_enrichment").delete({ count: "exact" }).in("asset_id", assetIds);
  return { ocr: clearOcr.count ?? assetIds.length, ai_enrichment: delEnrich.count ?? 0 };
}
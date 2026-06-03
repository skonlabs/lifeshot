// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * clusterPeople — surfaces people from face/person signals captured during AI
 * enrichment and persists them into `people` + `person_faces`.
 *
 * Biometric consent gate: only runs when the user has
 * privacy_settings.face_processing_enabled = true. Without a true face-vector
 * model we cannot do identity clustering, so we group all detected faces under
 * a single auto-created "People in your photos" person per user. This makes the
 * /people endpoint (and the dashboard "People" stat + people_filter in the
 * catalog viewport) return real, navigable data. When a real face-embedding
 * provider is wired in, person_faces.face_vector can be populated and proper
 * clustering layered on top — the schema already supports it.
 *
 * Idempotent: re-runs upsert on (person_id, asset_id) and on the person's
 * stable auto_label, so repeated invocations never duplicate rows.
 */
const AUTO_LABEL = "auto:unclustered-faces";

export async function clusterPeople(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, asset_id } = ctx.payload as { user_id?: string; asset_id?: string };
  const uid = user_id ?? ctx.userId;
  if (!uid) throw new Error("invalid: user_id");

  // Consent gate — biometric processing requires explicit opt-in.
  const { data: privacy } = await sb
    .from("privacy_settings")
    .select("face_processing_enabled")
    .eq("user_id", uid)
    .maybeSingle();
  if (!privacy?.face_processing_enabled) {
    return { user_id: uid, skipped: "consent", clustered: 0 };
  }

  // Collect assets that have at least one detected face.
  // Faces are stored on asset_ai_enrichment.faces; we also treat a "person"
  // object label as a weak face signal for assets enriched before faces existed.
  let enrichQuery = sb
    .from("asset_ai_enrichment")
    .select("asset_id, faces, objects")
    .eq("user_id", uid);
  if (asset_id) enrichQuery = enrichQuery.eq("asset_id", asset_id);

  const { data: enrichRows, error } = await enrichQuery;
  if (error) throw new Error(`clusterPeople fetch: ${error.message}`);

  const candidates: Array<{ asset_id: string; faces: any[] }> = [];
  for (const row of enrichRows ?? []) {
    const faces = Array.isArray(row.faces) ? row.faces : [];
    if (faces.length > 0) {
      candidates.push({ asset_id: row.asset_id, faces });
      continue;
    }
    const objs = Array.isArray(row.objects) ? row.objects : [];
    const hasPerson = objs.some((o: any) => {
      const label = (typeof o === "string" ? o : o?.label ?? "").toLowerCase();
      return label === "person" || label === "face" || label === "people";
    });
    if (hasPerson) candidates.push({ asset_id: row.asset_id, faces: [] });
  }

  if (candidates.length === 0) return { user_id: uid, clustered: 0 };

  // Ensure a stable auto-created person exists (deduped via people_user_auto_label_uniq).
  const { data: person, error: pErr } = await sb
    .from("people")
    .upsert(
      { user_id: uid, auto_label: AUTO_LABEL, display_name: "People in your photos", consent_required: true },
      { onConflict: "user_id,auto_label" },
    )
    .select("id")
    .single();
  if (pErr || !person) throw new Error(`clusterPeople person upsert: ${pErr?.message ?? "no row"}`);

  // Upsert person_faces in chunks (idempotent on person_id,asset_id).
  let linked = 0;
  for (let i = 0; i < candidates.length; i += 500) {
    const chunk = candidates.slice(i, i + 500).map((c) => {
      const top = c.faces[0] ?? {};
      return {
        person_id: person.id,
        asset_id: c.asset_id,
        bbox: top.bbox ?? null,
        confidence: typeof top.score === "number" ? top.score : null,
      };
    });
    const { error: fErr } = await sb
      .from("person_faces")
      .upsert(chunk, { onConflict: "person_id,asset_id" });
    if (fErr) throw new Error(`clusterPeople person_faces upsert: ${fErr.message}`);
    linked += chunk.length;
  }

  return { user_id: uid, person_id: person.id, clustered: linked };
}

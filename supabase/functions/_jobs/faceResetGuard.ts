// deno-lint-ignore-file no-explicit-any

export type FaceResetCheck =
  | { valid: true }
  | { valid: false; reason: "superseded_by_face_reset" };

/**
 * A /people/reset deletes queued jobs, but a worker may already be executing
 * one of those jobs in-memory. Guard every face-pipeline writer so a reset can
 * invalidate in-flight work before it writes stale faces/people back.
 */
export async function checkFaceResetGuard(
  sb: any,
  opts: { userId: string; jobId: string; resetAt?: string | null },
): Promise<FaceResetCheck> {
  const { data: jobRow, error: jobErr } = await sb
    .from("job_queue")
    .select("id, created_at, started_at")
    .eq("id", opts.jobId)
    .maybeSingle();

  if (jobErr) {
    console.warn("faceResetGuard: job lookup failed", opts.jobId, jobErr.message);
    return { valid: true };
  }

  if (!jobRow) {
    return { valid: false, reason: "superseded_by_face_reset" };
  }

  let resetAt = opts.resetAt ?? null;
  if (!resetAt) {
    const { data: privacy, error: privacyErr } = await sb
      .from("privacy_settings")
      .select("face_pipeline_reset_at")
      .eq("user_id", opts.userId)
      .maybeSingle();
    if (privacyErr) {
      console.warn("faceResetGuard: privacy lookup failed", opts.userId, privacyErr.message);
      return { valid: true };
    }
    resetAt = privacy?.face_pipeline_reset_at ?? null;
  }

  if (!resetAt) return { valid: true };

  const jobTimestamp = jobRow.started_at ?? jobRow.created_at ?? null;
  if (!jobTimestamp) return { valid: true };

  const resetMs = Date.parse(resetAt);
  const jobMs = Date.parse(jobTimestamp);
  if (Number.isNaN(resetMs) || Number.isNaN(jobMs)) return { valid: true };

  if (resetMs > jobMs) {
    return { valid: false, reason: "superseded_by_face_reset" };
  }

  return { valid: true };
}
// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "./clients.ts";
import { LANES, type LaneKey, laneFor } from "./lanes.ts";

export interface EnqueueOpts {
  userId?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  delaySeconds?: number;
  priorityOverride?: number;
  laneOverride?: LaneKey;
  maxAttempts?: number;
}

export interface EnqueueResult { id: string; deduped: boolean }

/** Insert a job into job_queue. Idempotency via job_ledger lookup first. */
export async function enqueueJob(jobName: string, opts: EnqueueOpts = {}): Promise<EnqueueResult> {
  const sb = serviceClient();
  const laneKey = opts.laneOverride ?? laneFor(jobName);
  const lane = LANES[laneKey];
  const next = new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000).toISOString();
  if (opts.idempotencyKey) {
    const { data: prior } = await sb.from("job_ledger")
      .select("id").eq("job_name", jobName).eq("idempotency_key", opts.idempotencyKey).maybeSingle();
    if (prior) return { id: prior.id, deduped: true };
    // Check job_queue. Only treat pending/running rows as duplicates — a
    // terminal row (completed/cancelled/failed/dead_letter) from a previous
    // cycle must NOT silently swallow a fresh enqueue, otherwise downstream
    // resets (e.g. /people/reset, face-pipeline reclusters) can never
    // re-trigger work for those assets. If a terminal row exists we revive
    // it in place to satisfy the (user_id, job_name, idempotency_key)
    // unique constraint.
    const { data: queued } = await sb.from("job_queue")
      .select("id, status, dead_letter")
      .eq("job_name", jobName)
      .eq("idempotency_key", opts.idempotencyKey)
      .maybeSingle();
    if (queued) {
      const status = (queued as { status?: string }).status;
      const dead   = (queued as { dead_letter?: boolean }).dead_letter ?? false;
      const active = !dead && (status === "pending" || status === "running");
      if (active) return { id: queued.id as string, deduped: true };
      // Revive the terminal row so the job runs again.
      const { error: revErr } = await sb.from("job_queue").update({
        status:          "pending",
        payload:         opts.payload ?? {},
        priority:        opts.priorityOverride ?? lane.priority,
        lane:            lane.name,
        attempts:        0,
        locked_at:       null,
        locked_by:       null,
        finished_at:     null,
        next_attempt_at: next,
        dead_letter:     false,
        last_error:      null,
        max_attempts:    opts.maxAttempts ?? 5,
      }).eq("id", queued.id as string);
      if (revErr) throw new Error(`enqueueJob(${jobName}) revive: ${revErr.message}`);
      return { id: queued.id as string, deduped: false };
    }
  }
  const { data, error } = await sb.from("job_queue").upsert({
    user_id: opts.userId ?? null,
    job_name: jobName,
    payload: opts.payload ?? {},
    status: "pending",
    priority: opts.priorityOverride ?? lane.priority,
    lane: lane.name,
    next_attempt_at: next,
    idempotency_key: opts.idempotencyKey ?? null,
    max_attempts: opts.maxAttempts ?? 5,
  }, { onConflict: "user_id,job_name,idempotency_key", ignoreDuplicates: true }).select("id").maybeSingle();
  if (error) throw new Error(`enqueueJob(${jobName}): ${error.message}`);
  if (!data) {
    // Race: another worker inserted concurrently. Look it up.
    const lookup = sb.from("job_queue")
      .select("id")
      .eq("job_name", jobName)
      .order("created_at", { ascending: false })
      .limit(1);
    const { data: existing } = opts.idempotencyKey
      ? await lookup.eq("idempotency_key", opts.idempotencyKey).maybeSingle()
      : await lookup.is("idempotency_key", null).maybeSingle();
    return { id: (existing?.id as string) ?? "", deduped: true };
  }
  return { id: data.id as string, deduped: false };
}

/** Bulk enqueue — single round-trip. */
export async function enqueueMany(jobs: Array<{ name: string; opts?: EnqueueOpts }>): Promise<string[]> {
  if (jobs.length === 0) return [];
  const sb = serviceClient();
  const rows = jobs.map(({ name, opts = {} }) => {
    const laneKey = opts.laneOverride ?? laneFor(name);
    const lane = LANES[laneKey];
    return {
      user_id: opts.userId ?? null,
      job_name: name,
      payload: opts.payload ?? {},
      status: "pending",
      priority: opts.priorityOverride ?? lane.priority,
      lane: lane.name,
      next_attempt_at: new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000).toISOString(),
      idempotency_key: opts.idempotencyKey ?? null,
      max_attempts: opts.maxAttempts ?? 5,
    };
  });
  // Use upsert with ignoreDuplicates so re-enqueueing the same idempotency
  // key (e.g. a sync page that touches an unchanged asset, or a retry) does
  // not violate the unique constraint job_queue_user_id_job_name_idempotency_key_key.
  const { data, error } = await sb.from("job_queue")
    .upsert(rows, { onConflict: "user_id,job_name,idempotency_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`enqueueMany: ${error.message}`);
  return (data ?? []).map((r: any) => r.id);
}

/** Convenience: write a ledger row after successful completion. */
export async function recordLedger(jobName: string, idempotencyKey: string, userId: string | null, result: unknown): Promise<void> {
  await serviceClient().from("job_ledger").upsert({
    job_name: jobName, idempotency_key: idempotencyKey, user_id: userId, result: result ?? {},
    status: "completed",
  }, { onConflict: "job_name,idempotency_key" });
}
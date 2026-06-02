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
  if (opts.idempotencyKey) {
    const { data: prior } = await sb.from("job_ledger")
      .select("id").eq("job_name", jobName).eq("idempotency_key", opts.idempotencyKey).maybeSingle();
    if (prior) return { id: prior.id, deduped: true };
    // Also check job_queue — a pending/running job with the same idempotency
    // key would violate the unique constraint on insert.
    const { data: queued } = await sb.from("job_queue")
      .select("id")
      .eq("job_name", jobName)
      .eq("idempotency_key", opts.idempotencyKey)
      .maybeSingle();
    if (queued) return { id: queued.id as string, deduped: true };
  }
  const laneKey = opts.laneOverride ?? laneFor(jobName);
  const lane = LANES[laneKey];
  const next = new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000).toISOString();
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
    const { data: existing } = await sb.from("job_queue")
      .select("id")
      .eq("job_name", jobName)
      .eq("idempotency_key", opts.idempotencyKey ?? "")
      .maybeSingle();
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
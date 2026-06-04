// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "./clients.ts";
import { backoffSeconds } from "./ratelimit.ts";
import { logger, metric, timed } from "./logger.ts";
import { JOB_HANDLERS, type JobName } from "../_jobs/registry.ts";
import { recordLedger } from "./enqueuer.ts";

export interface JobRow {
  id: string;
  user_id: string | null;
  job_name: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  lane: string;
  priority: number;
}

export interface JobContext {
  jobId: string;
  userId: string | null;
  payload: Record<string, unknown>;
  attempt: number;
  idempotencyKey: string | null;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

const WORKER_ID = `worker-${crypto.randomUUID().slice(0, 8)}`;
const DEFAULT_BATCH = 16;

export async function drainOnce(opts: { batch?: number; lanes?: string[] } = {}): Promise<{ claimed: number; ok: number; failed: number }> {
  const sb = serviceClient();
  const batch = opts.batch ?? DEFAULT_BATCH;
  const lanes = opts.lanes ?? null;
  const { data, error } = await sb.rpc("claim_pending_jobs", {
    _limit: batch, _worker_id: WORKER_ID, _lanes: lanes,
  });
  if (error) { logger.error("claim_failed", { error: error.message }); return { claimed: 0, ok: 0, failed: 0 }; }
  const rows = (data ?? []) as JobRow[];
  if (rows.length === 0) return { claimed: 0, ok: 0, failed: 0 };

  let ok = 0, failed = 0;
  await Promise.all(rows.map(async (job) => {
    const handler = JOB_HANDLERS[job.job_name as JobName];
    if (!handler) {
      await sb.rpc("fail_job", { _id: job.id, _error: `unknown job: ${job.job_name}`, _backoff_seconds: 60 });
      failed += 1; return;
    }
    try {
      const result = await timed("job", { name: job.job_name, lane: job.lane }, () => handler({
        jobId: job.id, userId: job.user_id, payload: job.payload ?? {},
        attempt: job.attempts, idempotencyKey: job.idempotency_key,
      }));
      await sb.rpc("complete_job", { _id: job.id, _result: result ?? {} });
      if (job.idempotency_key) await recordLedger(job.job_name, job.idempotency_key, job.user_id, result);
      metric("job.completed", 1, { name: job.job_name });
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = !/(permanent|invalid|unauthorized|forbidden|not found)/i.test(msg);
      const back = retryable ? backoffSeconds(job.attempts) : 24 * 3600;
      await sb.rpc("fail_job", { _id: job.id, _error: msg.slice(0, 500), _backoff_seconds: back });
      // If the failed job is syncSource, mark source_sync_jobs as failed so the
      // status endpoint doesn't show a perpetual stale "running" state.
      if (job.job_name === "syncSource") {
        const sourceAccountId = (job.payload as Record<string, unknown>)?.source_account_id as string | undefined;
        if (sourceAccountId) {
          await sb.from("source_sync_jobs")
            .update({ status: "failed", finished_at: new Date().toISOString() })
            .eq("id", job.id)
            .eq("status", "running");
          await sb.from("source_accounts")
            .update({ status: "error" })
            .eq("id", sourceAccountId);
        }
      }
      logger.error("job_failed", { name: job.job_name, id: job.id, attempt: job.attempts, error: msg });
      metric("job.failed", 1, { name: job.job_name });
      failed += 1;
    }
  }));

  return { claimed: rows.length, ok, failed };
}

export async function drainUntilEmpty(maxMs = 8000, batch = DEFAULT_BATCH): Promise<{ rounds: number; ok: number; failed: number }> {
  const t0 = Date.now();
  let rounds = 0, ok = 0, failed = 0;
  while (Date.now() - t0 < maxMs) {
    const r = await drainOnce({ batch });
    rounds += 1; ok += r.ok; failed += r.failed;
    if (r.claimed === 0) break;
  }
  return { rounds, ok, failed };
}

export async function drainUntilEmptyForLanes(
  maxMs = 8000,
  batch = DEFAULT_BATCH,
  lanes?: string[],
): Promise<{ rounds: number; ok: number; failed: number }> {
  const t0 = Date.now();
  let rounds = 0, ok = 0, failed = 0;
  while (Date.now() - t0 < maxMs) {
    const r = await drainOnce({ batch, lanes });
    rounds += 1; ok += r.ok; failed += r.failed;
    if (r.claimed === 0) break;
  }
  return { rounds, ok, failed };
}
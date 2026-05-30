import { serviceClient } from "./clients.ts";

export async function checkLedger(jobName: string, idempotencyKey: string): Promise<unknown | null> {
  const { data } = await serviceClient().from("job_ledger")
    .select("result").eq("job_name", jobName).eq("idempotency_key", idempotencyKey).maybeSingle();
  return data ? (data as { result: unknown }).result : null;
}
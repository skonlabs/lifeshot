// deno-lint-ignore-file no-explicit-any
import { Hono } from "../_shared/deps.ts";
import { drainOnce, drainUntilEmpty } from "../_pipeline/runner.ts";
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import { logger } from "../_pipeline/logger.ts";

// Supabase Edge Functions forward the full path (incl. /<function-name>) to
// the handler, so mount Hono under the "/worker" basePath.
const app = new Hono().basePath("/worker");

function authorize(req: Request): boolean {
  const expected = Deno.env.get("WORKER_SECRET") ?? "";
  if (!expected) return true; // allow if unset (dev/test)
  return req.headers.get("x-worker-secret") === expected;
}

app.use("*", async (c, next) => {
  if (!authorize(c.req.raw)) return c.text("Unauthorized", 401);
  await next();
});

app.get("/", (c) => c.json({ ok: true, service: "lifeshot-worker" }));

/** Drain N jobs (called by pg_cron every 10s). */
app.post("/drain", async (c) => {
  const url = new URL(c.req.url);
  const batch = Number(url.searchParams.get("batch") ?? "16");
  const r = await drainUntilEmpty(7000, batch);
  return c.json(r);
});

/** Synchronous drain for tests / fixture pipeline. */
app.post("/drain/sync", async (c) => {
  const r = await drainUntilEmpty(20000, 32);
  return c.json(r);
});

/** Manual single-round drain. */
app.post("/drain/once", async (c) => c.json(await drainOnce()));

/** Cron: enqueue incremental sync for every connected source. */
app.post("/cron/incremental-sync", async (c) => {
  const sb = serviceClient();
  const { data, error } = await sb.from("source_accounts")
    .select("id, user_id").eq("status", "connected").limit(2000);
  if (error) return c.json({ error: error.message }, 500);
  let enq = 0;
  for (const acct of data ?? []) {
    await enqueueJob("syncSource", {
      userId: acct.user_id,
      payload: { source_account_id: acct.id, mode: "incremental" },
      idempotencyKey: `cron-inc:${acct.id}:${new Date().toISOString().slice(0, 13)}`,
    });
    enq += 1;
  }
  return c.json({ enqueued: enq });
});

/** Cron: sweep dead-letter and stuck jobs reports. */
app.post("/cron/dead-letter-sweep", async (c) => {
  const sb = serviceClient();
  const { count } = await sb.from("dead_letter_jobs").select("id", { count: "exact", head: true });
  await sb.rpc("sweep_stuck_jobs", { _stale_seconds: 600 });
  logger.info("dead_letter_summary", { count });
  return c.json({ dead_letter: count ?? 0 });
});

/** Admin enqueue (used by API → worker handoff). Pass-through for trusted callers. */
app.post("/enqueue/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const r = await enqueueJob(name, body);
  return c.json(r);
});

app.onError((err, c) => {
  logger.error("worker_error", { error: String(err) });
  return c.json({ error: String(err) }, 500);
});

Deno.serve(app.fetch);
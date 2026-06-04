// deno-lint-ignore-file no-explicit-any
import { Hono } from "../_shared/deps.ts";
import { drainOnce, drainUntilEmpty } from "../_pipeline/runner.ts";
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import { logger } from "../_pipeline/logger.ts";
import { installOpenAIProviders } from "../_ai/factory.ts";

// Install real OpenAI providers when the environment is configured.
// Falls back silently to mock providers when OPENAI_API_KEY / LIFESHOT_AI_PROVIDER
// are absent (e.g. local dev without credentials).
installOpenAIProviders();

// Supabase Edge Functions forward the full path (incl. /<function-name>) to
// the handler, so mount Hono under the "/worker" basePath.
const app = new Hono().basePath("/worker");

function authorize(req: Request): boolean {
  const expected = Deno.env.get("WORKER_SECRET") ?? "";
  const providedSecret = req.headers.get("x-worker-secret");
  const authHeader = req.headers.get("authorization") ?? "";
  if (providedSecret && expected && providedSecret === expected) return true;
  if (authHeader.startsWith("Bearer ")) return true;
  return !expected; // allow if unset (dev/test)
}

app.use("*", async (c, next) => {
  if (!authorize(c.req.raw)) return c.text("Unauthorized", 401);
  await next();
});

app.get("/", (c) => c.json({ ok: true, service: "lifeshot-worker" }));

/** Drain pending jobs. Called by pg_cron every 15s and as a nudge from
 * /sources/.../sync. Budget is generous (50s of the 60s Edge Function limit)
 * so a single Dropbox list_folder call (~20s timeout) plus DB writes fits
 * comfortably inside one drain invocation. batch=4 keeps connector
 * concurrency reasonable. */
app.post("/drain", async (c) => {
  const url = new URL(c.req.url);
  const batch = Number(url.searchParams.get("batch") ?? "4");
  const budgetMs = Number(url.searchParams.get("budget_ms") ?? "50000");
  const r = await drainUntilEmpty(budgetMs, batch);
  return c.json(r);
});

/** Synchronous drain for tests / fixture pipeline. */
app.post("/drain/sync", async (c) => {
  const r = await drainUntilEmpty(20000, 32);
  return c.json(r);
});

/** Manual single-round drain. */
app.post("/drain/once", async (c) => c.json(await drainOnce()));

app.get("/debug/account/:id", async (c) => {
  const id = c.req.param("id");
  const sb = serviceClient();
  const { data: jobs, error } = await sb.from("job_queue")
    .select("id, status, attempts, lane, priority, next_attempt_at, locked_at, locked_by, last_error, dead_letter, created_at, started_at, finished_at, user_id")
    .eq("job_name", "syncSource")
    .contains("payload", { source_account_id: id })
    .order("created_at", { ascending: false })
    .limit(5);
  const { data: pendingByPriority } = await sb.from("job_queue")
    .select("job_name, lane, priority, count:id.count()")
    .eq("status", "pending");
  return c.json({ error: error?.message ?? null, jobs, pendingByPriority });
});

app.post("/debug/bump-priority", async (c) => {
  const sb = serviceClient();
  const { data, error } = await sb.from("job_queue")
    .update({ priority: 100 })
    .eq("status", "pending")
    .eq("lane", "user")
    .eq("job_name", "syncSource")
    .lt("priority", 100)
    .select("id");
  return c.json({ error: error?.message ?? null, updated: data?.length ?? 0, ids: data });
});

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
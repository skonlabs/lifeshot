// deno-lint-ignore-file no-explicit-any
import { Hono } from "../_shared/deps.ts";
import { drainOnce, drainUntilEmpty, drainUntilEmptyForLanes } from "../_pipeline/runner.ts";
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
  // Default batch is 2: larger batches occasionally trip
  // WORKER_RESOURCE_LIMIT on the Edge runtime, which kills the worker
  // mid-job and leaves locks behind. Smaller batches + self-perpetuating
  // drain keeps throughput high without crashing.
  const batch = Number(url.searchParams.get("batch") ?? "2");
  const budgetMs = Number(url.searchParams.get("budget_ms") ?? "50000");
  const lanes = url.searchParams.getAll("lanes").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  // Self-heal: reclaim any job whose worker died (locked > 120s). Without
  // this a crashed worker can leave a sync stuck waiting on jobs that no
  // one is processing, until the every-minute cron sweep catches up.
  try {
    await serviceClient().rpc("sweep_stuck_jobs", { _stale_seconds: 120 });
  } catch (err) {
    console.warn("worker self-heal sweep failed:", String(err));
  }
  const r = lanes.length
    ? await drainUntilEmptyForLanes(budgetMs, batch, lanes)
    : await drainUntilEmpty(budgetMs, batch);
  // Self-perpetuating drain: if the budget was exhausted and there are
  // still pending jobs ready to run, schedule another /drain invocation in
  // the background. This makes the worker resilient to a dead pg_cron
  // schedule — once anything kicks the worker, it keeps draining until
  // the queue is empty.
  try {
    const sb = serviceClient();
    const { count } = await sb
      .from("job_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString());
    if ((count ?? 0) > 0) {
      const selfUrl = new URL(c.req.url);
      const nextDrain = fetch(selfUrl.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-secret": Deno.env.get("WORKER_SECRET") ?? "",
          authorization: c.req.header("authorization") ?? "Bearer internal-worker",
        },
        body: "{}",
      }).catch((err) => console.warn("worker self-drain failed:", String(err)));
      // deno-lint-ignore no-explicit-any
      const edge = (globalThis as any).EdgeRuntime;
      if (edge?.waitUntil) edge.waitUntil(nextDrain);
    }
  } catch (err) {
    console.warn("worker self-drain check failed:", String(err));
  }
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
  // dead_letter_jobs was dropped in B-NUKE; failed jobs now stay in job_queue.
  const { count } = await sb.from("job_queue").select("id", { count: "exact", head: true }).eq("status", "failed");
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
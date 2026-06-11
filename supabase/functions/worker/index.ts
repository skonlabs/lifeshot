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

/** TEMP: diagnostic snapshot for sync/enrichment stalls. Remove after debug. */
app.get("/debug/stats", async (c) => {
  const sb = serviceClient();
  const url = new URL(c.req.url);
  const uid = url.searchParams.get("user_id");

  const out: Record<string, unknown> = {};

  // Job queue breakdown by name + status.
  const { data: jobs } = await sb.from("job_queue")
    .select("name, status, attempts, max_attempts, dead_letter, last_error, next_attempt_at, locked_by, locked_at, payload")
    .order("created_at", { ascending: false })
    .limit(2000);
  const byStatus: Record<string, number> = {};
  const byNameStatus: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const sampleErrors: Array<{ name: string; status: string; attempts: number; err: string }> = [];
  for (const j of jobs ?? []) {
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    const k = `${j.name}:${j.status}`;
    byNameStatus[k] = (byNameStatus[k] ?? 0) + 1;
    if (j.last_error) {
      const sig = String(j.last_error).slice(0, 120);
      errors[sig] = (errors[sig] ?? 0) + 1;
      if (sampleErrors.length < 20) sampleErrors.push({ name: j.name, status: j.status, attempts: j.attempts, err: String(j.last_error).slice(0, 400) });
    }
  }
  out.jobs_total = jobs?.length ?? 0;
  out.jobs_by_status = byStatus;
  out.jobs_by_name_status = byNameStatus;
  out.error_signatures = errors;
  out.sample_errors = sampleErrors;

  // Locked / running jobs (potential stuck).
  const { data: locked } = await sb.from("job_queue")
    .select("id, name, status, locked_by, locked_at, attempts, payload")
    .not("locked_at", "is", null)
    .order("locked_at", { ascending: true }).limit(20);
  out.locked_sample = locked ?? [];

  // Enrichment + faces + people counts.
  let enrichQ = sb.from("asset_ai_enrichment").select("asset_id, faces, processed_at", { count: "exact" });
  if (uid) enrichQ = enrichQ.eq("user_id", uid);
  const { count: enrichCount } = await enrichQ.range(0, 0);
  out.asset_ai_enrichment_count = enrichCount ?? 0;

  const { data: enrichRows } = await (uid
    ? sb.from("asset_ai_enrichment").select("asset_id, faces").eq("user_id", uid).limit(2000)
    : sb.from("asset_ai_enrichment").select("asset_id, faces").limit(2000));
  let withFaces = 0, withoutFaces = 0;
  for (const r of enrichRows ?? []) {
    const f = (r as any).faces;
    if (Array.isArray(f) && f.length > 0) withFaces++; else withoutFaces++;
  }
  out.enrichment_with_faces = withFaces;
  out.enrichment_without_faces = withoutFaces;

  let facesQ = sb.from("asset_faces").select("asset_id", { count: "exact", head: true });
  if (uid) facesQ = facesQ.eq("user_id", uid);
  const { count: faceCount } = await facesQ;
  out.asset_faces_count = faceCount ?? 0;

  let peopleQ = sb.from("people").select("id, display_name, auto_label, cover_face_crop, cover_asset_id, face_count, faces");
  if (uid) peopleQ = peopleQ.eq("user_id", uid);
  const { data: people } = await peopleQ.limit(500);
  let pWithFaces = 0, pWithCover = 0, pWithCoverCrop = 0;
  const peopleSample: Array<Record<string, unknown>> = [];
  for (const p of people ?? []) {
    const arr = Array.isArray((p as any).faces) ? (p as any).faces : [];
    if (arr.length > 0) pWithFaces++;
    if ((p as any).cover_asset_id) pWithCover++;
    if ((p as any).cover_face_crop) pWithCoverCrop++;
    if (peopleSample.length < 10) {
      peopleSample.push({
        id: (p as any).id,
        display_name: (p as any).display_name,
        auto_label: (p as any).auto_label,
        has_cover_face_crop: !!(p as any).cover_face_crop,
        cover_asset_id: (p as any).cover_asset_id,
        face_count: (p as any).face_count,
        faces_len: arr.length,
      });
    }
  }
  out.people_total = people?.length ?? 0;
  out.people_with_faces_jsonb = pWithFaces;
  out.people_with_cover_asset = pWithCover;
  out.people_with_cover_face_crop = pWithCoverCrop;
  out.people_sample = peopleSample;

  // privacy flag per user if asked.
  if (uid) {
    const { data: pr } = await sb.from("privacy_settings").select("face_processing_enabled").eq("user_id", uid).maybeSingle();
    out.privacy = pr ?? null;
    const { data: srcs } = await sb.from("source_accounts").select("id, provider, status").eq("user_id", uid);
    out.sources = srcs ?? [];
  }

  return c.json(out);
});

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
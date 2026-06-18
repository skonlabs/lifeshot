// deno-lint-ignore-file no-explicit-any
import { Hono } from "../_shared/deps.ts";
import { drainOnce, drainUntilEmpty, drainUntilEmptyForLanes } from "../_pipeline/runner.ts";
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import { logger } from "../_pipeline/logger.ts";
import { installOpenAIProviders } from "../_ai/factory.ts";
import { isUsableIndexedFace } from "../_ai/face-quality.ts";

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
    .select("job_name, status, attempts, max_attempts, dead_letter, last_error, next_attempt_at, locked_by, locked_at, payload")
    .order("created_at", { ascending: false })
    .limit(2000);
  const byStatus: Record<string, number> = {};
  const byNameStatus: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const sampleErrors: Array<{ job_name: string; status: string; attempts: number; err: string }> = [];
  for (const j of jobs ?? []) {
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    const k = `${j.job_name}:${j.status}`;
    byNameStatus[k] = (byNameStatus[k] ?? 0) + 1;
    if (j.last_error) {
      const sig = String(j.last_error).slice(0, 120);
      errors[sig] = (errors[sig] ?? 0) + 1;
      if (sampleErrors.length < 20) sampleErrors.push({ job_name: j.job_name, status: j.status, attempts: j.attempts, err: String(j.last_error).slice(0, 400) });
    }
  }
  out.jobs_total = jobs?.length ?? 0;
  out.jobs_by_status = byStatus;
  out.jobs_by_name_status = byNameStatus;
  out.error_signatures = errors;
  out.sample_errors = sampleErrors;

  // Locked / running jobs (potential stuck).
  const { data: locked } = await sb.from("job_queue")
    .select("id, job_name, status, locked_by, locked_at, attempts, payload")
    .not("locked_at", "is", null)
    .order("locked_at", { ascending: true }).limit(20);
  out.locked_sample = locked ?? [];

  // Enrichment + faces + people counts. Use current column names only.
  const countRows = async (table: string, build?: (q: any) => any) => {
    let q = sb.from(table).select("*", { count: "exact", head: true });
    if (uid) q = q.eq("user_id", uid);
    if (build) q = build(q);
    const { count, error } = await q;
    return error ? { error: error.message } : count ?? 0;
  };
  out.assets_total = await countRows("assets");
  out.photo_assets = await countRows("assets", (q) => q.eq("media_type", "photo"));
  if (!uid && url.searchParams.get("include_users") === "1") {
    const { data: assetUsers } = await sb.from("assets").select("user_id").limit(50000);
    const userAssetCounts: Record<string, number> = {};
    for (const row of assetUsers ?? []) {
      const userId = String((row as any).user_id ?? "");
      if (userId) userAssetCounts[userId] = (userAssetCounts[userId] ?? 0) + 1;
    }
    out.user_asset_counts = userAssetCounts;
  }
  out.asset_ai_enrichment_count = await countRows("asset_ai_enrichment");
  out.asset_ai_face_processed = await countRows("asset_ai_enrichment", (q) => q.not("face_count", "is", null));
  out.asset_ai_with_faces = await countRows("asset_ai_enrichment", (q) => q.gt("face_count", 0));
  out.asset_faces_count = await countRows("asset_faces");
  out.asset_faces_linked = await countRows("asset_faces", (q) => q.not("person_id", "is", null));
  out.asset_faces_unlinked = await countRows("asset_faces", (q) => q.is("person_id", null));
  const { data: faceRows } = await (uid
    ? sb.from("asset_faces").select("id, asset_id, person_id, face, created_at").eq("user_id", uid).limit(50000)
    : sb.from("asset_faces").select("id, asset_id, person_id, face, created_at").limit(50000));
  const faceBreakdown = {
    usable_linked: 0,
    usable_unlinked: 0,
    unusable_linked: 0,
    unusable_unlinked: 0,
    unlinked_reasons: {} as Record<string, number>,
    unlinked_samples: [] as Array<Record<string, unknown>>,
  };
  for (const row of faceRows ?? []) {
    const usable = isUsableIndexedFace((row as any).face);
    const linked = !!(row as any).person_id;
    if (usable && linked) faceBreakdown.usable_linked++;
    if (usable && !linked) faceBreakdown.usable_unlinked++;
    if (!usable && linked) faceBreakdown.unusable_linked++;
    if (!usable && !linked) faceBreakdown.unusable_unlinked++;
    if (!linked) {
      const detail = (row as any).face?.FaceDetail ?? {};
      const confidence = Number((row as any).face?.Confidence ?? 0);
      const reasons = [
        confidence < 90 ? "confidence" : null,
        Math.abs(Number(detail?.Pose?.Yaw ?? 0)) > 30 ? "yaw" : null,
        Math.abs(Number(detail?.Pose?.Pitch ?? 0)) > 25 ? "pitch" : null,
        Number(detail?.Quality?.Sharpness ?? 0) < 2 ? "sharpness" : null,
        Number(detail?.Quality?.Brightness ?? 0) < 15 ? "brightness" : null,
        detail?.FaceOccluded?.Value === true ? "occluded" : null,
        detail?.EyesOpen?.Value === false ? "eyes_closed" : null,
      ].filter(Boolean) as string[];
      const key = reasons.length ? reasons.join("+") : "passes_quality_unlinked";
      faceBreakdown.unlinked_reasons[key] = (faceBreakdown.unlinked_reasons[key] ?? 0) + 1;
      if (faceBreakdown.unlinked_samples.length < 20) {
        faceBreakdown.unlinked_samples.push({
          asset_id: (row as any).asset_id,
          face_id: (row as any).face?.FaceId ?? null,
          confidence,
          yaw: detail?.Pose?.Yaw ?? null,
          pitch: detail?.Pose?.Pitch ?? null,
          sharpness: detail?.Quality?.Sharpness ?? null,
          brightness: detail?.Quality?.Brightness ?? null,
          occluded: detail?.FaceOccluded?.Value ?? null,
          eyes_open: detail?.EyesOpen?.Value ?? null,
          reason: key,
        });
      }
    }
  }
  out.asset_faces_quality_breakdown = faceBreakdown;

  let peopleQ = sb.from("people").select("id, display_name, asset_id, face");
  if (uid) peopleQ = peopleQ.eq("user_id", uid);
  const { data: people } = await peopleQ.limit(500);
  const peopleSample: Array<Record<string, unknown>> = [];
  const uniqueNames = new Set<string>();
  for (const p of people ?? []) {
    if (p.display_name) uniqueNames.add(p.display_name);
    if (peopleSample.length < 10) {
      peopleSample.push({
        id:            (p as any).id,
        display_name:  (p as any).display_name,
        asset_id:      (p as any).asset_id,
        face_id:       (p as any).face?.FaceId ?? null,
        face_confidence: (p as any).face?.Confidence ?? null,
      });
    }
  }
  out.people_rows_total    = people?.length ?? 0;
  out.people_unique_names  = uniqueNames.size;
  out.people_sample        = peopleSample;

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
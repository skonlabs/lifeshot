function readEnv(name: string): string {
  const denoValue = globalThis.Deno?.env.get(name);
  if (typeof denoValue === "string" && denoValue.length > 0) return denoValue;
  const processValue = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return typeof processValue === "string" ? processValue : "";
}

export interface WorkerDrainOptions {
  authHeader?: string | null;
  requestUrl?: string | null;
  supabaseUrl?: string | null;
  batch?: number;
  budgetMs?: number;
  lanes?: string[];
}

export function getWorkerWakeHeaders(authHeader?: string | null): HeadersInit {
  const secret = readEnv("WORKER_SECRET");
  const anonKey = readEnv("SUPABASE_ANON_KEY") || readEnv("ANON_KEY");
  const bearer = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader
    : (anonKey ? `Bearer ${anonKey}` : "Bearer internal-worker");

  return {
    "content-type": "application/json",
    authorization: bearer,
    ...(secret ? { "x-worker-secret": secret } : {}),
  };
}

export function getWorkerDrainUrl(opts: WorkerDrainOptions = {}): string | null {
  const candidates = [opts.requestUrl, opts.supabaseUrl ?? readEnv("SUPABASE_URL")]
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const base = candidates
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "";
      }
    })
    .find((origin) => origin.includes(".supabase.co"));

  if (!base) return null;

  const url = new URL(`${base}/functions/v1/worker/drain`);
  url.searchParams.set("batch", String(opts.batch ?? 4));
  url.searchParams.set("budget_ms", String(opts.budgetMs ?? 50_000));
  for (const lane of opts.lanes ?? []) {
    if (lane.trim()) url.searchParams.append("lanes", lane.trim());
  }
  return url.toString();
}

async function fallbackHttpDrain(opts: WorkerDrainOptions): Promise<void> {
  const workerUrl = getWorkerDrainUrl(opts);
  if (!workerUrl) return;

  await fetch(workerUrl, {
    method: "POST",
    headers: getWorkerWakeHeaders(opts.authHeader),
    body: JSON.stringify({}),
  }).catch(() => undefined);
}

async function fallbackInProcessDrain(opts: WorkerDrainOptions): Promise<void> {
  try {
    const { drainUntilEmpty, drainUntilEmptyForLanes } = await import("./runner.ts");
    if ((opts.lanes?.length ?? 0) > 0) {
      await drainUntilEmptyForLanes(opts.budgetMs ?? 50_000, opts.batch ?? 4, opts.lanes);
      return;
    }
    await drainUntilEmpty(opts.budgetMs ?? 50_000, opts.batch ?? 4);
  } catch {
    // best effort
  }
}

export async function nudgeWorkerDrain(opts: WorkerDrainOptions = {}): Promise<void> {
  const task = (async () => {
    const workerUrl = getWorkerDrainUrl(opts);
    if (workerUrl) {
      await fallbackHttpDrain(opts);
      return;
    }

    await fallbackInProcessDrain(opts);
  })();

  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(task);
    return;
  }

  await task;
}
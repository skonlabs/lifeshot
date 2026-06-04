function readEnv(name: string): string {
  const denoValue = globalThis.Deno?.env.get(name);
  if (typeof denoValue === "string" && denoValue.length > 0) return denoValue;
  const processValue = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return typeof processValue === "string" ? processValue : "";
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
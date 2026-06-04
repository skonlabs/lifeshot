export function getWorkerWakeHeaders(authHeader?: string | null): HeadersInit {
  const secret = Deno.env.get("WORKER_SECRET") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? "";
  const bearer = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader
    : (anonKey ? `Bearer ${anonKey}` : "Bearer internal-worker");

  return {
    "content-type": "application/json",
    authorization: bearer,
    ...(secret ? { "x-worker-secret": secret } : {}),
  };
}
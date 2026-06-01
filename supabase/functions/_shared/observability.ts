import type { Context, Next } from "./deps.ts";

export async function withRequestId(c: Context, next: Next) {
  const id = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(JSON.stringify({
    requestId: id, route: new URL(c.req.url).pathname,
    method: c.req.method, status: c.res.status, latency_ms: ms,
    user: c.get("userId") ?? null,
  }));
}

export function emitEvent(c: Context, name: string, props: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    event: name, requestId: c.get("requestId"),
    user: c.get("userId"), props,
  }));
}

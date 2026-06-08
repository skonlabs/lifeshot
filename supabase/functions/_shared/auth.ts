import type { Context, Next } from "./deps.ts";
import { getUserClient } from "./clients.ts";
import { ApiError } from "./errors.ts";

export async function withAuth(c: Context, next: Next) {
  const supa = getUserClient(c);
  // Retry once on clock-skew ("JWT issued at future") which happens right
  // after sign-in when the auth server clock lags the edge runtime by <1s.
  let data: Awaited<ReturnType<typeof supa.auth.getUser>>["data"] | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await supa.auth.getUser();
    if (!res.error && res.data?.user) { data = res.data; lastErr = null; break; }
    lastErr = res.error;
    const msg = String(res.error?.message ?? "");
    if (!/issued at future|clock|iat/i.test(msg)) break;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!data?.user) throw new ApiError("unauthorized", `Invalid or expired token${lastErr ? `: ${(lastErr as Error).message}` : ""}`);
  c.set("userId", data.user.id);
  c.set("userEmail", data.user.email ?? null);
  c.set("supabase", supa);
  await next();
}

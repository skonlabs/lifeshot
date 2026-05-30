import type { Context, Next } from "./deps.ts";
import { getUserClient } from "./clients.ts";
import { ApiError } from "./errors.ts";

export async function withAuth(c: Context, next: Next) {
  const supa = getUserClient(c);
  const { data, error } = await supa.auth.getUser();
  if (error || !data.user) throw new ApiError("unauthorized", "Invalid or expired token");
  c.set("userId", data.user.id);
  c.set("userEmail", data.user.email ?? null);
  c.set("supabase", supa);
  await next();
}

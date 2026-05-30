import type { Context } from "./deps.ts";
import type { ZodTypeAny } from "./deps.ts";
import { ApiError } from "./errors.ts";

export async function parseBody<T extends ZodTypeAny>(c: Context, schema: T): Promise<ReturnType<T["parse"]>> {
  let raw: unknown = {};
  try { raw = await c.req.json(); } catch { /* allow empty */ }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError("validation_failed", "Invalid body", { issues: r.error.issues });
  return r.data;
}

export function parseQuery<T extends ZodTypeAny>(c: Context, schema: T): ReturnType<T["parse"]> {
  const obj = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const r = schema.safeParse(obj);
  if (!r.success) throw new ApiError("validation_failed", "Invalid query", { issues: r.error.issues });
  return r.data;
}

export function parseParams<T extends ZodTypeAny>(c: Context, schema: T): ReturnType<T["parse"]> {
  const r = schema.safeParse(c.req.param());
  if (!r.success) throw new ApiError("validation_failed", "Invalid path params", { issues: r.error.issues });
  return r.data;
}

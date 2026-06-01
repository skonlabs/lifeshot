/**
 * Typed API client for the LifeShot Supabase edge functions.
 * Each backend function (catalog, search, sources, …) is exposed at:
 *   {SUPABASE_URL}/functions/v1/<fn>/v1/<path>
 * The wrapper injects the Supabase access token, adds Idempotency-Key on
 * unsafe methods, parses the typed error envelope, retries idempotent GETs.
 */
import { supabase, SUPABASE_URL } from "@/lib/supabase";

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "rate_limited"
  | "dependency_unavailable"
  | "internal";

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode | string,
    message: string,
    public status: number,
    public requestId?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type ApiFn =
  | "catalog"
  | "search"
  | "sources"
  | "me"
  | "organization"
  | "families"
  | "privacy";

interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function authHeader(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? `Bearer ${token}` : null;
}

function buildUrl(fn: ApiFn, path: string, query?: RequestOpts["query"]): string {
  const base = `${SUPABASE_URL}/functions/v1/${fn}/v1`;
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function apiCall<T = unknown>(
  fn: ApiFn,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const url = buildUrl(fn, path, opts.query);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": uuid(),
  };
  const auth = await authHeader();
  if (auth) headers["authorization"] = auth;
  if (method !== "GET" && method !== "DELETE") {
    headers["idempotency-key"] = opts.idempotencyKey ?? uuid();
  }

  const maxAttempts = method === "GET" ? 3 : 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
      const reqId = res.headers.get("x-request-id") ?? undefined;
      const text = await res.text();
      const parsed = text ? safeJson(text) : null;
      if (!res.ok) {
        const env = (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
        const err = new ApiError(
          env?.code ?? "internal",
          env?.message ?? `HTTP ${res.status}`,
          res.status,
          reqId,
          env?.details,
        );
        // Retry on 5xx / 429 for idempotent GETs.
        if (method === "GET" && (res.status >= 500 || res.status === 429) && attempt < maxAttempts - 1) {
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      return (parsed ?? {}) as T;
    } catch (e) {
      lastErr = e;
      if (e instanceof ApiError) throw e;
      if (attempt === maxAttempts - 1) break;
      await sleep(200 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Network error");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Convenience accessor — typed wrappers per function */
export const api = {
  catalog: <T,>(p: string, o?: RequestOpts) => apiCall<T>("catalog", p, o),
  search: <T,>(p: string, o?: RequestOpts) => apiCall<T>("search", p, o),
  sources: <T,>(p: string, o?: RequestOpts) => apiCall<T>("sources", p, o),
  me: <T,>(p: string, o?: RequestOpts) => apiCall<T>("me", p, o),
  organization: <T,>(p: string, o?: RequestOpts) => apiCall<T>("organization", p, o),
  families: <T,>(p: string, o?: RequestOpts) => apiCall<T>("families", p, o),
  privacy: <T,>(p: string, o?: RequestOpts) => apiCall<T>("privacy", p, o),
};
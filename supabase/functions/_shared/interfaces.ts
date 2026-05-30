// Mocks for JobEnqueuer, QueryParser, Embedder. Real implementations replace
// these via env (LIFESHOT_USE_REAL_*=1) — not implemented in this prompt.
import { getServiceClient } from "./clients.ts";

export interface JobEnqueuer {
  enqueue(name: string, payload: Record<string, unknown>, opts?: {
    userId?: string; idempotencyKey?: string; priority?: number;
  }): Promise<{ id: string }>;
}

export const jobEnqueuer: JobEnqueuer = {
  async enqueue(name, payload, opts = {}) {
    const s = getServiceClient();
    const row = {
      user_id: opts.userId ?? null,
      job_name: name,
      payload,
      idempotency_key: opts.idempotencyKey ?? crypto.randomUUID(),
      priority: opts.priority ?? 5,
    };
    const { data, error } = await s.from("job_queue")
      .upsert(row, { onConflict: "user_id,job_name,idempotency_key" })
      .select("id").single();
    if (error) throw new Error(`enqueue failed: ${error.message}`);
    return { id: data!.id };
  },
};

export interface QueryParser {
  parse(query: string): Promise<{
    intent: "browse" | "find" | "filter";
    entities: { dates?: string[]; sources?: string[]; people?: string[]; places?: string[] };
    filterPlan: Record<string, unknown>;
  }>;
}

const SOURCE_HINTS = ["google","icloud","dropbox","onedrive","whatsapp","ios","android","nas","drive","photos","amazon"];
export const queryParser: QueryParser = {
  async parse(query) {
    const q = query.toLowerCase();
    const sources = SOURCE_HINTS.filter(s => q.includes(s));
    const years = [...q.matchAll(/\b(19|20)\d{2}\b/g)].map(m => m[0]);
    const places: string[] = [];
    const filterPlan: Record<string, unknown> = {};
    if (years.length) {
      filterPlan.from = `${years[0]}-01-01`;
      filterPlan.to   = `${years[years.length - 1]}-12-31`;
    }
    if (sources.length) filterPlan.sources = sources;
    return {
      intent: years.length || sources.length ? "filter" : "find",
      entities: { dates: years, sources, places, people: [] },
      filterPlan,
    };
  },
};

export interface Embedder {
  embed(text: string): Promise<number[]>;
  readonly dim: number;
}

// Deterministic mock embedder (DIM 1536, matches asset_embeddings column)
export const embedder: Embedder = {
  dim: 1536,
  async embed(text) {
    const buf = new TextEncoder().encode(text);
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    const out = new Array<number>(1536);
    for (let i = 0; i < 1536; i++) out[i] = ((h[i % h.length] / 255) * 2 - 1);
    // normalize
    let s = 0; for (const v of out) s += v * v;
    const inv = 1 / Math.sqrt(s);
    for (let i = 0; i < out.length; i++) out[i] *= inv;
    return out;
  },
};

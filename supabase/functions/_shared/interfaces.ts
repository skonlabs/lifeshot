// Mocks for JobEnqueuer, QueryParser, Embedder. Real implementations replace
// these via env (LIFESHOT_USE_REAL_*=1) — not implemented in this prompt.
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import { installOpenAIProviders } from "../_ai/factory.ts";
import { parseQuery as openaiParse } from "../_ai/parser.ts";
import { embedText as openaiEmbed } from "../_ai/embedder.ts";

const AI_ON = (() => {
  try { return installOpenAIProviders(); } catch { return false; }
})();

export interface JobEnqueuer {
  enqueue(name: string, payload: Record<string, unknown>, opts?: {
    userId?: string; idempotencyKey?: string; priority?: number;
  }): Promise<{ id: string }>;
}

export const jobEnqueuer: JobEnqueuer = {
  async enqueue(name, payload, opts = {}) {
    const result = await enqueueJob(name, {
      userId: opts.userId,
      payload,
      idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
      priorityOverride: opts.priority,
    });
    return { id: result.id };
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
    if (AI_ON) {
      try {
        const p = await openaiParse(query);
        return {
          intent: p.intent === "browse" ? "browse" : "filter",
          entities: {
            dates: [p.entities.date_range?.from, p.entities.date_range?.to].filter(Boolean) as string[],
            sources: p.entities.sources,
            people: p.entities.people,
            places: p.entities.places,
          },
          filterPlan: p.filter_plan as unknown as Record<string, unknown>,
        };
      } catch { /* fall through to heuristic */ }
    }
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
    const mediaTypeMap: [RegExp, string][] = [
      [/\b(videos?|clips?|footage|reels?|movies?)\b/, "video"],
      [/\b(docs?|documents?|pdfs?|files?|spreadsheets?|presentations?)\b/, "document"],
      [/\b(audios?|music|songs?|tracks?|podcasts?)\b/, "audio"],
      [/\b(photos?|images?|pictures?|pics?|shots?|portraits?)\b/, "photo"],
    ];
    for (const [re, type] of mediaTypeMap) {
      if (re.test(q)) { filterPlan.media_type = type; break; }
    }
    const hasFilter = years.length || sources.length || filterPlan.media_type;
    return {
      intent: hasFilter ? "filter" : "find",
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
    if (AI_ON) {
      try { return await openaiEmbed(text); } catch { /* fall back */ }
    }
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

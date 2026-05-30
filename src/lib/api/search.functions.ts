import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Universal Search — STUB.
 * Real impl runs in parallel: structured filters (SQL) +
 * tsvector FTS + pgvector HNSW + OCR; ranker merges with the
 * formula documented in the architecture (0.45 cosine + 0.25 ts_rank + ...).
 */
export const searchMemories = createServerFn({ method: "POST" })
  .inputValidator((input: { q: string }) =>
    z.object({ q: z.string().min(1).max(500) }).parse(input),
  )
  .handler(async ({ data }) => {
    return {
      query_id: crypto.randomUUID(),
      took_ms: 0,
      parsed: { freeText: data.q, places: [], dateRange: null, people: [] },
      facets: { by_year: {}, by_place: {}, by_source: {} },
      results: [] as Array<{ asset_id: string; explanations: string[] }>,
      next_cursor: null as string | null,
    };
  });
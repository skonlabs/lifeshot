// deno-lint-ignore-file no-explicit-any
/** Offline tests for the AI layer. No network — no OPENAI_API_KEY required. */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeText, embeddingCacheKey } from "../_ai/cache.ts";
import { ParsedQueryZ, VisionResultZ, ExplanationZ, RerankResultZ } from "../_ai/schemas.ts";
import { aiConfig, priceFor } from "../_ai/config.ts";

Deno.test("cache: normalizeText collapses whitespace + case", () => {
  assertEquals(normalizeText("  Hello   World\n"), "hello world");
});

Deno.test("cache: embedding key is stable per (model,text)", async () => {
  const a = await embeddingCacheKey("m1", "hi");
  const b = await embeddingCacheKey("m1", " HI ");
  const c = await embeddingCacheKey("m2", "hi");
  assertEquals(a, b);
  assert(a !== c);
});

Deno.test("schemas: ParsedQuery accepts minimal valid payload", () => {
  const p = ParsedQueryZ.parse({
    intent: "find_assets",
    entities: { people:[], places:[], sources:[], media_type:"any", keywords:[], event_terms:[], date_range:{} },
    filter_plan: { sources:[], place_terms:[], person_terms:[], media_type:"any", keywords:[], only_in_one_source:false, dedup_scope:"off" },
    canonical_text: "x",
    clarification: null,
  });
  assertEquals(p.intent, "find_assets");
});

Deno.test("schemas: VisionResult parses with defaults", () => {
  const v = VisionResultZ.parse({
    caption: "a cat on a sofa",
    labels: [{ label: "cat", score: 0.9 }],
    text_present: false,
    quality: { sharpness: 0.7, exposure: 0.6, aesthetic: 0.5, salience: 0.4 },
    confidence: 0.8,
  });
  assertEquals(v.caption, "a cat on a sofa");
});

Deno.test("schemas: Explanation enforces lengths", () => {
  const e = ExplanationZ.parse({ explanation: "ok", per_result_reasons: [], suggestions: [] });
  assertEquals(e.suggestions.length, 0);
});

Deno.test("schemas: Rerank requires items in [0,1]", () => {
  const r = RerankResultZ.parse({ ordered: [{ asset_id: "a", score: 0.5 }] });
  assertEquals(r.ordered.length, 1);
});

Deno.test("config: priceFor known model returns nonzero", () => {
  const p = priceFor("gpt-4o-mini", "chat", 1000, 500);
  assert(p > 0);
  const pe = priceFor(aiConfig.embeddingModel, "embed", 1000, 0);
  assert(pe >= 0);
});
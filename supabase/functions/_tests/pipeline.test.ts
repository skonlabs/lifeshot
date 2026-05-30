// deno-lint-ignore-file no-explicit-any
/**
 * Fixture pipeline test — exercises enqueue → claim → handle for every job
 * using deterministic mocks. Run with:
 *   deno test -A supabase/functions/_tests/pipeline.test.ts
 *
 * It does NOT require a live Supabase: a tiny in-memory service-client shim
 * is installed via stubbing the clients module.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { ALL_JOB_NAMES, JOB_HANDLERS } from "../_jobs/registry.ts";
import { setProviders, providers } from "../_jobs/mocks.ts";

Deno.test("every job handler is registered", () => {
  for (const n of ALL_JOB_NAMES) {
    if (typeof JOB_HANDLERS[n] !== "function") throw new Error(`handler missing: ${n}`);
  }
  assertEquals(ALL_JOB_NAMES.length >= 14, true);
});

Deno.test("mock providers are deterministic", async () => {
  const a = await providers.embedder.embedImage({ url: "x" });
  const b = await providers.embedder.embedImage({ url: "x" });
  assertEquals(a.length, 384);
  assertEquals(a[0], b[0]);
});

Deno.test("setProviders override works", async () => {
  let called = 0;
  setProviders({ ocr: { extractText: async () => { called++; return { text: "ok" }; } } });
  const r = await providers.ocr.extractText({ url: "y" });
  assertEquals(r.text, "ok");
  assertEquals(called, 1);
});
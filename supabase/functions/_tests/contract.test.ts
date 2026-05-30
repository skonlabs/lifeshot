// deno test --allow-all supabase/functions/_tests/contract.test.ts
import { assertEquals } from "jsr:@std/assert";
import { ViewportIn, SearchIn, ConnectIn, ConsentIn } from "../../../packages/core/api/schemas.ts";

Deno.test("ViewportIn rejects oversize", () => {
  const r = ViewportIn.safeParse({ viewport_size: 500 });
  assertEquals(r.success, false);
});
Deno.test("ViewportIn rejects unknown keys", () => {
  const r = ViewportIn.safeParse({ viewport_size: 60, foo: 1 });
  assertEquals(r.success, false);
});
Deno.test("SearchIn requires query", () => {
  assertEquals(SearchIn.safeParse({}).success, false);
  assertEquals(SearchIn.safeParse({ query: "x" }).success, true);
});
Deno.test("ConnectIn requires uuid provider_id", () => {
  assertEquals(ConnectIn.safeParse({ provider_id: "abc" }).success, false);
});
Deno.test("ConsentIn enum scope", () => {
  assertEquals(ConsentIn.safeParse({ scope: "ai_processing", granted: true }).success, true);
  assertEquals(ConsentIn.safeParse({ scope: "foo", granted: true }).success, false);
});

import { assertEquals } from "jsr:@std/assert@1";
import { SUPPORTED_PROVIDERS } from "../_sources/registry.ts";

Deno.test("all 11 providers registered", () => {
  assertEquals(SUPPORTED_PROVIDERS.length, 11);
  for (const p of ["google_photos","local_ios","local_android","export_import","dropbox","onedrive","nas","external_drive","desktop_folder","icloud","amazon_photos"]) {
    if (!SUPPORTED_PROVIDERS.includes(p as any)) throw new Error(`missing provider: ${p}`);
  }
});
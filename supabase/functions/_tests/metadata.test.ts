import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateSearchDocument, tokenize } from "../_metadata/search-document.ts";
import { redactPath, sha256Hex, normalizedPathHash } from "../_metadata/path-redaction.ts";

Deno.test("redactPath keeps last two segments", () => {
  assertEquals(redactPath("/Users/jane/Photos/2024/IMG_001.jpg"), ".../2024/IMG_001.jpg");
  assertEquals(redactPath("/a/b"), "a/b");
  assertEquals(redactPath(null), null);
});

Deno.test("normalizedPathHash is case-insensitive + stable", async () => {
  const a = await normalizedPathHash("/A/B/c.JPG");
  const b = await normalizedPathHash("/a/b/c.jpg");
  assertEquals(a, b);
});

Deno.test("sha256Hex matches known vector", async () => {
  const h = await sha256Hex("abc");
  assertEquals(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

Deno.test("generateSearchDocument produces narrative", () => {
  const doc = generateSearchDocument({
    mediaType: "photo",
    mimeType: "image/jpeg",
    captureTime: "2024-06-01T12:00:00Z",
    source: { sourceKind: "local_folder", sourceAssetId: "x" },
    fileSystem: { filename: "IMG_001.jpg", relativePath: "Trips/Italy/IMG_001.jpg" },
    media: { width: 4000, height: 3000 },
    exif: { cameraMake: "Canon", cameraModel: "R5" },
    gps: { gpsLatitude: 41.9, gpsLongitude: 12.5, reverseGeocodedCity: "Rome", reverseGeocodedCountry: "Italy" },
    xmpIptc: { xmpKeywords: ["vacation","family"] },
    organization: { folderTokens: ["Trips","Italy"], eventHint: "Rome trip" },
    extractionErrors: [],
  } as any);
  assertStringIncludes(doc, "IMG_001.jpg");
  assertStringIncludes(doc, "Canon R5");
  assertStringIncludes(doc, "Rome");
  assertStringIncludes(doc, "vacation");
});

Deno.test("tokenize splits and lowercases", () => {
  const t = tokenize("Hello, WORLD! Foo123 baz");
  assertEquals(t, ["hello","world","foo123","baz"]);
});
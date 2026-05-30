// deno-lint-ignore-file no-explicit-any
import type { AIEnricher, DerivedRenderer, EmailSender, EmbedderProvider, Geocoder, OCRProvider } from "./interfaces.ts";

/** Deterministic 384-dim embedding seeded by a string. */
function seededVector(seed: string, dim = 384): number[] {
  // FNV-1a 32-bit hash → seed a tiny xorshift PRNG → unit-normalize.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let s = h || 1;
  const v = new Array(dim);
  let sumsq = 0;
  for (let i = 0; i < dim; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    const x = ((s & 0xffff) / 0xffff) * 2 - 1;
    v[i] = x; sumsq += x * x;
  }
  const n = Math.sqrt(sumsq) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

export const mockEmbedder: EmbedderProvider = {
  embedImage: async ({ url, bytes }) => seededVector(url ?? (bytes ? bytes.length.toString() : "image")),
  embedText:  async (t) => seededVector(`text:${t}`),
};

export const mockAI: AIEnricher = {
  caption: async ({ url }) => ({ caption: `auto: ${(url ?? "asset").slice(0, 32)}`, tags: ["photo", "scene"] }),
  detectObjects: async () => [{ label: "person", score: 0.9 }, { label: "outdoor", score: 0.7 }],
};

export const mockOCR: OCRProvider = {
  extractText: async () => ({ text: "", lang: "en" }),
};

export const mockGeocoder: Geocoder = {
  reverse: async (lat, lng) => ({
    place_id: `mock:${lat.toFixed(2)}:${lng.toFixed(2)}`,
    name: "Unknown Place", country: "—", admin: "—",
  }),
};

/** Renders a 1x1 PNG placeholder — fast and deterministic for tests. */
export const mockRenderer: DerivedRenderer = {
  render: async ({ kind }) => ({
    bytes: new Uint8Array([
      137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,
      0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,
      0,0,0,13,73,68,65,84,120,156,99,0,1,0,0,5,0,1,
      13,10,45,180,0,0,0,0,73,69,78,68,174,66,96,130,
    ]),
    mime: "image/png",
    blurhash: kind === "thumb" ? "L6PZfSi_.AyE_3t7t7R**0o#DgR4" : undefined,
  }),
};

export const mockEmail: EmailSender = {
  send: async () => ({ id: `mock-${crypto.randomUUID()}` }),
};

/** Singleton container so tests can swap providers without rewiring callers. */
export const providers = {
  embedder: mockEmbedder as EmbedderProvider,
  ai: mockAI as AIEnricher,
  ocr: mockOCR as OCRProvider,
  geocoder: mockGeocoder as Geocoder,
  renderer: mockRenderer as DerivedRenderer,
  email: mockEmail as EmailSender,
};

export function setProviders(overrides: Partial<typeof providers>) {
  Object.assign(providers, overrides);
}
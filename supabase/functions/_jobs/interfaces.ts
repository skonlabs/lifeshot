// deno-lint-ignore-file no-explicit-any
/**
 * Pluggable provider interfaces. Worker code depends only on these so that
 * tests can swap in deterministic mocks (which is what we ship by default).
 */
export interface EmbedderProvider {
  embedImage(input: { bytes?: Uint8Array; url?: string; mime?: string }): Promise<number[]>;
  embedText(text: string): Promise<number[]>;
}

export interface AIEnricher {
  caption(input: { url?: string; bytes?: Uint8Array }): Promise<{ caption: string; tags: string[] }>;
  detectObjects(input: { url?: string; bytes?: Uint8Array }): Promise<Array<{ label: string; score: number }>>;
}

export interface OCRProvider {
  extractText(input: { url?: string; bytes?: Uint8Array }): Promise<{ text: string; lang?: string }>;
}

export interface Geocoder {
  reverse(lat: number, lng: number): Promise<{ place_id?: string; name?: string; country?: string; admin?: string }>;
}

export interface FaceDetector {
  detectFaces(input: { url?: string; imageUrl?: string; userId: string; assetId: string }): Promise<Array<{
    bbox: { x: number; y: number; w: number; h: number } | null;
    description: string;
    confidence: number;
    embedding: number[] | null;
    face_id: string | null;
  }>>;
}

export interface DerivedRenderer {
  /** Returns a placeholder rendition (deterministic for tests). */
  render(input: { sourceUrl?: string; sourceBytes?: Uint8Array; width: number; height: number; kind: "thumb" | "preview" }):
    Promise<{ bytes: Uint8Array; mime: string; blurhash?: string }>;
}

export interface EmailSender {
  send(input: { to: string; subject: string; html: string; text?: string }): Promise<{ id: string }>;
}
// deno-lint-ignore-file no-explicit-any
/** SHA-256-keyed caches for embeddings, vision results, and search outputs. */
import { serviceClient } from "../_pipeline/clients.ts";

async function sha256Hex(s: string): Promise<string> {
  const b = new TextEncoder().encode(s);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(h).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function normalizeText(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export async function embeddingCacheKey(model: string, text: string): Promise<string> {
  return await sha256Hex(`${model}::${normalizeText(text)}`);
}

export async function getEmbeddingCached(model: string, text: string): Promise<number[] | null> {
  const sb = serviceClient();
  const key = await embeddingCacheKey(model, text);
  const { data } = await sb.from("ai_embedding_cache").select("embedding, dim").eq("cache_key", key).maybeSingle();
  if (!data) return null;
  return data.embedding as number[];
}

export async function setEmbeddingCached(model: string, dim: number, text: string, vec: number[]): Promise<void> {
  const sb = serviceClient();
  const key = await embeddingCacheKey(model, text);
  await sb.from("ai_embedding_cache").upsert({ cache_key: key, model, dim, embedding: vec });
}

export async function visionCacheKey(assetId: string, model: string, promptVersion: string): Promise<string> {
  return await sha256Hex(`${assetId}::${model}::${promptVersion}`);
}

export async function getVisionCached<T>(assetId: string, model: string, promptVersion: string): Promise<T | null> {
  const sb = serviceClient();
  const key = await visionCacheKey(assetId, model, promptVersion);
  const { data } = await sb.from("ai_vision_cache").select("payload").eq("cache_key", key).maybeSingle();
  return data ? (data.payload as T) : null;
}

export async function setVisionCached(assetId: string, model: string, promptVersion: string, payload: unknown): Promise<void> {
  const sb = serviceClient();
  const key = await visionCacheKey(assetId, model, promptVersion);
  await sb.from("ai_vision_cache").upsert({ cache_key: key, asset_id: assetId, model, prompt_version: promptVersion, payload });
}

export async function searchCacheKey(userId: string, normalizedQuery: string, filterPlan: unknown): Promise<string> {
  return await sha256Hex(`${userId}::${normalizedQuery}::${JSON.stringify(filterPlan)}`);
}

export async function getSearchCached<T>(userId: string, key: string): Promise<T | null> {
  const sb = serviceClient();
  const nowIso = new Date().toISOString();
  const { data } = await sb.from("search_result_cache")
    .select("payload, expires_at")
    .eq("user_id", userId).eq("cache_key", key).maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;
  void nowIso;
  return data.payload as T;
}

export async function setSearchCached(userId: string, key: string, payload: unknown, ttlSec: number): Promise<void> {
  const sb = serviceClient();
  const expires = new Date(Date.now() + ttlSec * 1000).toISOString();
  await sb.from("search_result_cache").upsert(
    { user_id: userId, cache_key: key, payload, expires_at: expires },
    { onConflict: "user_id,cache_key" },
  );
}
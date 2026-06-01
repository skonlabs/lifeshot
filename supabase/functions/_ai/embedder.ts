// deno-lint-ignore-file no-explicit-any
/** Text-embedding service: cached, batched, dim-asserted. */
import { aiConfig, assertDim } from "./config.ts";
import { embedBatch, type CallContext } from "./client.ts";
import { getEmbeddingCached, setEmbeddingCached, normalizeText } from "./cache.ts";

export async function embedText(text: string, ctx?: CallContext): Promise<number[]> {
  const t = normalizeText(text);
  const hit = await getEmbeddingCached(aiConfig.embeddingModel, t);
  if (hit) return hit;
  const [vec] = await embedBatch([t], { ctx });
  assertDim(vec.length);
  await setEmbeddingCached(aiConfig.embeddingModel, vec.length, t, vec);
  return vec;
}

export async function embedTexts(texts: string[], ctx?: CallContext): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  const miss: { i: number; t: string }[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = normalizeText(texts[i]);
    const hit = await getEmbeddingCached(aiConfig.embeddingModel, t);
    if (hit) out[i] = hit;
    else miss.push({ i, t });
  }
  for (let s = 0; s < miss.length; s += aiConfig.embedBatchSize) {
    const chunk = miss.slice(s, s + aiConfig.embedBatchSize);
    const vecs = await embedBatch(chunk.map((x) => x.t), { ctx });
    for (let j = 0; j < chunk.length; j++) {
      assertDim(vecs[j].length);
      out[chunk[j].i] = vecs[j];
      await setEmbeddingCached(aiConfig.embeddingModel, vecs[j].length, chunk[j].t, vecs[j]);
    }
  }
  return out;
}
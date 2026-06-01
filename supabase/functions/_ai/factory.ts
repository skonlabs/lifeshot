// deno-lint-ignore-file no-explicit-any
/**
 * Provider factory. When LIFESHOT_AI_PROVIDER=openai AND OPENAI_API_KEY is
 * present, replaces the mock providers used by job handlers with real OpenAI
 * backed implementations. Safe no-op otherwise.
 */
import { providers, setProviders } from "../_jobs/mocks.ts";
import { embedText } from "./embedder.ts";
import { enrichVision } from "./vision.ts";
import { ocrImage } from "./ocr.ts";
import { aiConfig } from "./config.ts";
import { logger } from "../_pipeline/logger.ts";

let installed = false;

function envFlag(name: string): string | undefined {
  return (typeof Deno !== "undefined" ? Deno.env.get(name) : (globalThis as any).process?.env?.[name]) ?? undefined;
}

/** Idempotent. Returns true if OpenAI providers were installed. */
export function installOpenAIProviders(): boolean {
  if (installed) return true;
  const provider = envFlag("LIFESHOT_AI_PROVIDER");
  const key = envFlag("OPENAI_API_KEY");
  if (provider !== "openai" || !key) return false;

  setProviders({
    embedder: {
      embedImage: async ({ url }) => {
        // Image embeddings: we describe URL as text proxy; vision enrichment
        // produces caption/labels that feed a much higher-quality text embed
        // upstream. For now use the URL as a low-information fallback.
        return await embedText(url ?? "image");
      },
      embedText: async (t) => await embedText(t),
    },
    ai: {
      caption: async ({ url }) => {
        if (!url) return { caption: "", tags: [] };
        const v = await enrichVision({ assetId: `inline:${url.slice(-32)}`, imageUrl: url });
        return { caption: v.caption, tags: v.labels.map((l) => l.label) };
      },
      detectObjects: async ({ url }) => {
        if (!url) return [];
        const v = await enrichVision({ assetId: `inline:${url.slice(-32)}`, imageUrl: url });
        return v.labels.map((l) => ({ label: l.label, score: l.score }));
      },
    },
    ocr: {
      extractText: async ({ url }) => {
        if (!url) return { text: "" };
        const r = await ocrImage({ imageUrl: url });
        return { text: r.text, lang: r.lang ?? undefined };
      },
    },
  });
  installed = true;
  logger.info("ai_providers_installed", { provider: "openai", model: aiConfig.embeddingModel });
  return true;
}

/** Re-export for callers that want direct access. */
export { providers };
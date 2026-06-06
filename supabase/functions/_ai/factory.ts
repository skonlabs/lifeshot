// deno-lint-ignore-file no-explicit-any
/**
 * Provider factory. Installs real providers:
 *  - Geocoder (Nominatim/OSM): always installed — no API key required.
 *  - AI / Embedder / OCR / FaceDetector: installed when LIFESHOT_AI_PROVIDER=openai
 *    AND OPENAI_API_KEY is present.
 */
import { providers, setProviders } from "../_jobs/mocks.ts";
import { embedText } from "./embedder.ts";
import { enrichVision } from "./vision.ts";
import { ocrImage } from "./ocr.ts";
import { detectFaces } from "./face-detector.ts";
import { reverseGeocode } from "./geocoder.ts";
import { aiConfig } from "./config.ts";
import { logger } from "../_pipeline/logger.ts";

let installed = false;

function envFlag(name: string): string | undefined {
  return (typeof Deno !== "undefined" ? Deno.env.get(name) : (globalThis as any).process?.env?.[name]) ?? undefined;
}

/** Idempotent. Always installs geocoder; returns true if OpenAI providers were also installed. */
export function installOpenAIProviders(): boolean {
  if (installed) return true;

  // Always install real Nominatim geocoder — free, no key required.
  setProviders({
    geocoder: {
      reverse: async (lat, lng) => {
        const r = await reverseGeocode(lat, lng);
        return { name: r.name, country: r.country ?? undefined, admin: r.admin ?? undefined };
      },
    },
  });

  const provider = envFlag("LIFESHOT_AI_PROVIDER");
  const key = envFlag("OPENAI_API_KEY");
  // Activate OpenAI providers whenever an API key is present. The
  // LIFESHOT_AI_PROVIDER toggle is only honored to *explicitly force-disable*
  // OpenAI (set it to "mock" / "none" / "disabled" / "off"). Any other value
  // — including stale opaque tokens left behind from previous configs — is
  // ignored so the OPENAI_API_KEY presence remains the source of truth.
  // Previously requiring provider === "openai" meant deploys silently fell
  // back to the 38-char mock captions with zero faces / objects whenever
  // the env var carried a non-"openai" value.
  const disabledValues = new Set(["mock", "none", "disabled", "off", "false", "0"]);
  const disabled = provider != null && disabledValues.has(provider.trim().toLowerCase());
  if (disabled || !key) {
    installed = true;
    logger.info("ai_providers_installed", { provider: "nominatim_only", reason: disabled ? "disabled" : "no_key" });
    return false;
  }

  setProviders({
    embedder: {
      embedImage: async ({ url }) => {
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
    faceDetector: {
      detectFaces: async ({ url, userId, assetId }) => {
        return await detectFaces({ imageUrl: url, userId, assetId });
      },
    },
  });

  installed = true;
  logger.info("ai_providers_installed", { provider: "openai", model: aiConfig.embeddingModel });
  return true;
}

/** Re-export for callers that want direct access. */
export { providers };

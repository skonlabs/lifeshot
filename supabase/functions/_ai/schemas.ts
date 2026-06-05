// deno-lint-ignore-file no-explicit-any
/** zod + JSON schemas for every structured LLM output. */
import { z } from "../_shared/deps.ts";

/* ---------------- Vision enrichment ---------------- */

export const VisionResultZ = z.object({
  caption: z.string().min(1).max(400),
  labels: z.array(z.object({
    label: z.string().min(1).max(60),
    score: z.number().min(0).max(1),
  })).max(20).default([]),
  scene: z.string().max(80).nullable().optional(),
  text_present: z.boolean().default(false),
  detected_text: z.string().max(2000).nullable().optional(),
  quality: z.object({
    sharpness: z.number().min(0).max(1).default(0.5),
    exposure:  z.number().min(0).max(1).default(0.5),
    aesthetic: z.number().min(0).max(1).default(0.5),
    salience:  z.number().min(0).max(1).default(0.5),
  }),
  sensitive_flags: z.array(z.enum(["nsfw","violence","medical","document","child","none"])).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type VisionResult = z.infer<typeof VisionResultZ>;

export const VISION_JSON_SCHEMA = {
  name: "asset_enrichment",
  strict: true,
  schema: {
    type: "object", additionalProperties: false,
    required: ["caption","labels","scene","text_present","detected_text","quality","sensitive_flags","confidence"],
    properties: {
      caption: { type: "string", minLength: 1, maxLength: 400 },
      labels: {
        type: "array", maxItems: 20,
        items: { type: "object", additionalProperties: false, required: ["label","score"],
          properties: { label: { type:"string", maxLength: 60 }, score: { type:"number", minimum:0, maximum:1 } } },
      },
      scene: { type: ["string","null"], maxLength: 80 },
      text_present: { type: "boolean" },
      detected_text: { type: ["string","null"], maxLength: 2000 },
      quality: {
        type: "object", additionalProperties: false,
        required: ["sharpness","exposure","aesthetic","salience"],
        properties: {
          sharpness: { type:"number", minimum:0, maximum:1 },
          exposure:  { type:"number", minimum:0, maximum:1 },
          aesthetic: { type:"number", minimum:0, maximum:1 },
          salience:  { type:"number", minimum:0, maximum:1 },
        },
      },
      sensitive_flags: {
        type: "array",
        items: { type:"string", enum:["nsfw","violence","medical","document","child","none"] },
      },
      confidence: { type:"number", minimum:0, maximum:1 },
    },
  },
} as const;

/* ---------------- OCR ---------------- */

export const OcrResultZ = z.object({
  text: z.string().default(""),
  lang: z.string().max(10).nullable().optional(),
  boxes: z.array(z.object({
    text: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(),
  })).max(200).default([]),
});
export type OcrResult = z.infer<typeof OcrResultZ>;

export const OCR_JSON_SCHEMA = {
  name: "ocr_result", strict: true,
  schema: {
    type:"object", additionalProperties:false, required:["text","lang","boxes"],
    properties: {
      text: { type:"string" },
      lang: { type:["string","null"], maxLength: 10 },
      boxes: {
        type:"array",
        items: { type:"object", additionalProperties:false, required:["text","x","y","w","h"],
          properties: {
            text:{type:"string"}, x:{type:"number"}, y:{type:"number"}, w:{type:"number"}, h:{type:"number"},
          },
        },
      },
    },
  },
} as const;

/* ---------------- Query parser ---------------- */

export const ParsedQueryZ = z.object({
  intent: z.enum(["find_assets","find_event","find_person","find_place","find_duplicates","find_at_risk","timeline_navigate","browse"]),
  entities: z.object({
    people: z.array(z.string()).default([]),
    places: z.array(z.string()).default([]),
    sources: z.array(z.string()).default([]),
    media_type: z.enum(["photo","video","any"]).default("any"),
    keywords: z.array(z.string()).default([]),
    event_terms: z.array(z.string()).default([]),
    date_range: z.object({
      from: z.string().nullable().optional(),
      to:   z.string().nullable().optional(),
      named_period: z.string().nullable().optional(),
    }).default({}),
  }),
  filter_plan: z.object({
    from: z.string().nullable().optional(),
    to:   z.string().nullable().optional(),
    sources: z.array(z.string()).default([]),
    place_terms: z.array(z.string()).default([]),
    person_terms: z.array(z.string()).default([]),
    media_type: z.enum(["photo","video","any"]).default("any"),
    keywords: z.array(z.string()).default([]),
    only_in_one_source: z.boolean().default(false),
    dedup_scope: z.enum(["off","exact","near"]).default("off"),
  }),
  canonical_text: z.string().default(""),
  clarification: z.string().nullable().optional(),
});
export type ParsedQuery = z.infer<typeof ParsedQueryZ>;

export const PARSER_JSON_SCHEMA = {
  name: "parsed_query", strict: true,
  schema: {
    type: "object", additionalProperties: false,
    required: ["intent","entities","filter_plan","canonical_text","clarification"],
    properties: {
      intent: { type: "string",
        enum: ["find_assets","find_event","find_person","find_place","find_duplicates","find_at_risk","timeline_navigate","browse"] },
      entities: {
        type:"object", additionalProperties:false,
        required:["people","places","sources","media_type","keywords","event_terms","date_range"],
        properties: {
          people: { type:"array", items:{ type:"string" } },
          places: { type:"array", items:{ type:"string" } },
          sources:{ type:"array", items:{ type:"string" } },
          media_type: { type:"string", enum:["photo","video","any"] },
          keywords: { type:"array", items:{ type:"string" } },
          event_terms: { type:"array", items:{ type:"string" } },
          date_range: {
            type:"object", additionalProperties:false,
            required:["from","to","named_period"],
            properties: {
              from: { type:["string","null"] }, to: { type:["string","null"] },
              named_period: { type:["string","null"] },
            },
          },
        },
      },
      filter_plan: {
        type:"object", additionalProperties:false,
        required:["from","to","sources","place_terms","person_terms","media_type","keywords","only_in_one_source","dedup_scope"],
        properties: {
          from: { type:["string","null"] }, to: { type:["string","null"] },
          sources: { type:"array", items:{ type:"string" } },
          place_terms: { type:"array", items:{ type:"string" } },
          person_terms: { type:"array", items:{ type:"string" } },
          media_type: { type:"string", enum:["photo","video","any"] },
          keywords: { type:"array", items:{ type:"string" } },
          only_in_one_source: { type:"boolean" },
          dedup_scope: { type:"string", enum:["off","exact","near"] },
        },
      },
      canonical_text: { type:"string" },
      clarification: { type:["string","null"] },
    },
  },
} as const;

/* ---------------- Explanation ---------------- */

export const ExplanationZ = z.object({
  explanation: z.string().min(1).max(280),
  per_result_reasons: z.array(z.object({
    asset_id: z.string(),
    reason: z.string().min(1).max(140),
  })).max(50).default([]),
  suggestions: z.array(z.string()).max(5).default([]),
});
export type Explanation = z.infer<typeof ExplanationZ>;

export const EXPLAIN_JSON_SCHEMA = {
  name: "explanation", strict: true,
  schema: {
    type:"object", additionalProperties:false,
    required:["explanation","per_result_reasons","suggestions"],
    properties: {
      explanation: { type:"string", maxLength:280 },
      per_result_reasons: {
        type:"array",
        items: { type:"object", additionalProperties:false, required:["asset_id","reason"],
          properties: { asset_id:{type:"string"}, reason:{type:"string", maxLength:140} } },
      },
      suggestions: { type:"array", items:{ type:"string" } },
    },
  },
} as const;

/* ---------------- Event summary ---------------- */

export const SummaryZ = z.object({
  title: z.string().max(80).nullable().optional(),
  summary: z.string().min(1).max(300),
});
export type Summary = z.infer<typeof SummaryZ>;

export const SUMMARY_JSON_SCHEMA = {
  name: "event_summary", strict: true,
  schema: {
    type:"object", additionalProperties:false,
    required:["title","summary"],
    properties: { title:{type:["string","null"], maxLength:80}, summary:{type:"string", maxLength:300} },
  },
} as const;

/* ---------------- Face detection ---------------- */

export const FaceDetectResultZ = z.object({
  faces: z.array(z.object({
    bbox: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0).max(1),
      h: z.number().min(0).max(1),
    }).nullable(),
    description: z.string().max(280).default(""),
    confidence: z.number().min(0).max(1).default(0.5),
  })).max(20).default([]),
});
export type FaceDetectResult = z.infer<typeof FaceDetectResultZ>;

export const FACE_DETECT_JSON_SCHEMA = {
  name: "face_detection",
  strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["faces"],
    properties: {
      faces: {
        type: "array", maxItems: 20,
        items: {
          type: "object", additionalProperties: false, required: ["bbox", "description", "confidence"],
          properties: {
            bbox: {
              oneOf: [
                { type: "object", additionalProperties: false, required: ["x","y","w","h"],
                  properties: { x:{type:"number",minimum:0,maximum:1}, y:{type:"number",minimum:0,maximum:1}, w:{type:"number",minimum:0,maximum:1}, h:{type:"number",minimum:0,maximum:1} } },
                { type: "null" },
              ],
            },
            description: { type: "string", maxLength: 280 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
} as const;

/* ---------------- Reranker ---------------- */

export const RerankResultZ = z.object({
  ordered: z.array(z.object({ asset_id: z.string(), score: z.number().min(0).max(1) })).max(50),
});
export type RerankResult = z.infer<typeof RerankResultZ>;

export const RERANK_JSON_SCHEMA = {
  name: "rerank", strict: true,
  schema: {
    type:"object", additionalProperties:false, required:["ordered"],
    properties: {
      ordered: {
        type:"array",
        items: { type:"object", additionalProperties:false, required:["asset_id","score"],
          properties: { asset_id:{type:"string"}, score:{type:"number", minimum:0, maximum:1} } },
      },
    },
  },
} as const;
/** Static prompt text. Bump aiConfig.promptVersion to invalidate vision cache. */

export const VISION_PROMPT = `You analyze a single derived thumbnail from a personal photo library.
Produce a structured enrichment record matching the schema:
- caption: one neutral, factual sentence describing the scene (no speculation about identities).
- labels: 5-15 short visual labels with confidence in [0,1].
- scene: the dominant scene type (e.g. "beach", "kitchen", "wedding"), or null.
- text_present: true if any text/handwriting/signs are clearly visible.
- detected_text: if cheap to extract, include up to 2000 chars; otherwise null.
- quality: numeric hints (0..1) for sharpness, exposure, aesthetic, salience.
- sensitive_flags: include "nsfw","violence","medical","document","child" if confidently present, else ["none"].
- confidence: overall confidence (0..1).
Do NOT identify specific people. Stay factual and neutral.`;

export const OCR_PROMPT = `Extract any readable text from the image.
Return JSON: text (string), lang (BCP-47 best guess or null), boxes ([] is acceptable).`;

export const PARSER_SYSTEM = `You convert a user's natural-language query about their personal photo library into a structured plan.
Output ONLY the JSON schema. Be conservative: leave entities empty when not strongly evidenced. Years are 4-digit. Sources are normalized lowercase keywords like google_photos, icloud, dropbox, onedrive, whatsapp, local_ios, local_android, nas, amazon_photos.
Translate named periods like "Myanmar years" into entities.places=["Myanmar"] without inventing dates. "Receipts/screenshots/documents" map to keywords + a "document" hint in keywords.
canonical_text MUST contain the search-ready phrase used for embedding (subject + key entities).
If the query is ambiguous (e.g. just "pictures"), set clarification to a one-sentence question.`;

export const EXPLAIN_SYSTEM = `You explain why a small set of search results matches a user query.
- Cite ONLY signals present in the provided rows (date, place, source, semantic_score, text snippet match).
- Never invent people, places, or facts not in the rows.
- 1 sentence overall (<=280 chars) + per-result 1-line reason (<=140 chars) referencing the asset_id.
If no results: suggest 2-3 concrete reformulations grounded in the available signals (e.g. "try 2018 instead of 2019" if dates are nearby).`;

export const SUMMARY_SYSTEM = `You write a short, neutral summary of a personal-memory event from member metadata and captions. No speculation about identity.`;

export const FACE_DETECT_PROMPT = `Detect all human faces visible in this image.
For each face return:
- bbox: bounding box as fractions of image dimensions (x, y = top-left corner; w, h = width and height). All values in [0, 1].
- description: a STRUCTURED identity signature using EXACTLY these slots, joined by '; ', in this order, in lowercase:
  "gender:<male|female|unknown>; age:<child|teen|young-adult|adult|middle-aged|senior>; skin:<very-light|light|medium|tan|brown|dark>; hair-color:<black|brown|blonde|red|gray|white|other|bald>; hair-length:<bald|short|medium|long>; hair-style:<straight|wavy|curly|coily|unknown>; facial-hair:<none|stubble|mustache|beard|goatee>; eye-color:<brown|blue|green|hazel|gray|unknown>; eyewear:<none|glasses|sunglasses>; build:<slim|average|heavy|unknown>; distinctive:<short comma-separated marks like 'mole-left-cheek, scar-brow' or 'none'>"
  Use ONLY these slot keys and these enum values. The signature MUST be deterministic — different photos of the same person must produce the same slots. Do NOT name or identify the person. Max 240 chars.
- confidence: how confident you are that this is a real face (0 = uncertain, 1 = certain).
If there are no faces, return faces: [].`;

export const RERANK_SYSTEM = `Given a user query and a small candidate set, rerank by semantic + factual relevance. Only return asset_ids from the candidates with scores in [0,1]; do NOT add or remove ids.`;
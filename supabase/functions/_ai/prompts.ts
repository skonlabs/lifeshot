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

export const PARSER_SYSTEM = `Parse a personal photo library query into structured JSON. Output ONLY the JSON.
Context (when provided after "---"): today's date, people list (id|name), events list (id|title|from|to), places list (id|name).

RULES (be conservative — leave arrays empty when not evidenced):
- people_ids_all_of: ALL must appear together ("X and Y", "me with Z"). people_ids_any_of: ANY is fine.
- "me/myself/I" → people[0].id (first person in list). Relational terms ("my wife/mom/dad") → fuzzy-match people[].name.
- Unresolved names → entities.people fallback only (leave people_ids_* empty).
- Dates: resolve named periods using today. "last summer"=Jun1–Aug31 prev year. "last year"=full prev year. "recently"=3mo ago–today. Output ISO dates in filter_plan.from/to.
- Events: fuzzy-match query against events list → event_ids. Generic terms ("camping") → keywords only unless a specific event matches.
- Places: fuzzy-match → place_ids. Also add original term to entities.places.
- is_temporal_query=true for "last time I was with X / when did I last see X / most recent photo with X".
- friendly_response: 1–2 warm sentences saying what you'll show. No exact counts. Note unresolved names.
- canonical_text: embedding-ready phrase (subject + key entities). Years are 4-digit.
- Sources: google_photos icloud dropbox onedrive whatsapp local_ios local_android nas amazon_photos.
- media_type: "any" unless explicitly asked for photos or videos.`;

export const EXPLAIN_SYSTEM = `You explain why a small set of search results matches a user query.
- Cite ONLY signals present in the provided rows (date, place, source, semantic_score, text snippet match).
- Never invent people, places, or facts not in the rows.
- 1 sentence overall (<=280 chars) + per-result 1-line reason (<=140 chars) referencing the asset_id.
If no results: suggest 2-3 concrete reformulations grounded in the available signals (e.g. "try 2018 instead of 2019" if dates are nearby).`;

export const SUMMARY_SYSTEM = `You write a short, neutral summary of a personal-memory event from member metadata and captions. No speculation about identity.`;

export const FACE_DETECT_PROMPT = `Detect all human faces visible in this image.
For each face return:
- bbox: bounding box as fractions of image dimensions (x, y = top-left corner; w, h = width and height). All values in [0, 1]. The box MUST cover only the face/head region (forehead, eyes, nose, mouth, chin, a little hair), not shoulders, torso, hands, clothing, or background. If you cannot isolate a face-only box, omit that face.
- description: a STRUCTURED identity signature using EXACTLY these slots, joined by '; ', in this order, in lowercase:
  "gender:<male|female|unknown>; age:<child|teen|young-adult|adult|middle-aged|senior>; skin:<very-light|light|medium|tan|brown|dark>; hair-color:<black|brown|blonde|red|gray|white|other|bald>; hair-length:<bald|short|medium|long>; hair-style:<straight|wavy|curly|coily|unknown>; facial-hair:<none|stubble|mustache|beard|goatee>; eye-color:<brown|blue|green|hazel|gray|unknown>; eyewear:<none|glasses|sunglasses>; build:<slim|average|heavy|unknown>; distinctive:<short comma-separated marks like 'mole-left-cheek, scar-brow' or 'none'>"
  Use ONLY these slot keys and these enum values. The signature MUST be deterministic — different photos of the same person must produce the same slots. Do NOT name or identify the person. Max 240 chars.
- confidence: how confident you are that this is a real face (0 = uncertain, 1 = certain).
Reject partial people, backs of heads, profile fragments with no full face, bodies, clothing regions, and any crop larger than the head. When multiple candidate boxes overlap the same face, return only the tightest valid face box.
If there are no faces, return faces: [].`;

export const RERANK_SYSTEM = `Given a user query and a small candidate set, rerank by semantic + factual relevance. Only return asset_ids from the candidates with scores in [0,1]; do NOT add or remove ids.`;
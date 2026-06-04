/**
 * Priority lanes. Higher priority number = drained first.
 * Lane name maps to job_queue.lane; priority maps to job_queue.priority.
 */
export const LANES = {
  user_triggered:       { name: "user",       priority: 100, concurrency: 16 },
  visible_assets:       { name: "visible",    priority:  90, concurrency: 16 },
  recent_assets:        { name: "recent",     priority:  80, concurrency: 12 },
  sync_ingest:          { name: "ingest",     priority:  75, concurrency: 24 },
  metadata:             { name: "metadata",   priority:  70, concurrency: 24 },
  derived:              { name: "derived",    priority:  60, concurrency: 12 },
  search_index:         { name: "search",     priority:  50, concurrency:  8 },
  ai_deep:              { name: "ai",         priority:  20, concurrency:  4 },
  throttled:            { name: "throttled",  priority:  10, concurrency:  2 },
  cascade:              { name: "cascade",    priority:  95, concurrency:  4 },
  email:                { name: "email",      priority:  40, concurrency:  4 },
} as const;

export type LaneKey = keyof typeof LANES;
export type LaneName = typeof LANES[LaneKey]["name"];

export function laneFor(jobName: string): LaneKey {
  switch (jobName) {
    case "syncSource":                  return "user_triggered";
    case "normalizeMetadata":           return "sync_ingest";
    case "hashAsset":                   return "metadata";
    case "generateDerived":             return "derived";
    case "indexSearchDocument":         return "search_index";
    case "materializeTimelineWindows":  return "search_index";
    case "embedAsset":                  return "ai_deep";
    case "enrichAI":                    return "ai_deep";
    case "ocrAsset":                    return "ai_deep";
    case "dedupGroup":                  return "search_index";
    case "detectEvents":
    case "clusterPlaces":
    case "clusterPeople":               return "ai_deep";
    case "disconnectSource":
    case "deleteAccount":
    case "exportUserData":              return "cascade";
    case "sendInvitationEmail":         return "email";
    default:                            return "metadata";
  }
}

export const ALL_LANE_NAMES: LaneName[] = Object.values(LANES).map(l => l.name);
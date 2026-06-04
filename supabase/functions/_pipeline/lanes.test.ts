import { describe, expect, it } from "vitest";

import { laneFor, LANES } from "./lanes.ts";

describe("laneFor", () => {
  it("routes normalizeMetadata through the dedicated ingest lane", () => {
    expect(laneFor("normalizeMetadata")).toBe("sync_ingest");
    expect(LANES.sync_ingest.name).toBe("ingest");
    expect(LANES.sync_ingest.priority).toBeGreaterThan(LANES.metadata.priority);
  });
});
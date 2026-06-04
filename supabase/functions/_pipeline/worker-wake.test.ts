import { describe, expect, it } from "vitest";
import { getWorkerDrainUrl, getWorkerWakeHeaders } from "./worker-wake.ts";

describe("getWorkerWakeHeaders", () => {
  it("always includes an authorization header for internal worker nudges", () => {
    const headers = new Headers(getWorkerWakeHeaders());

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeTruthy();
  });

  it("preserves a caller bearer token when provided", () => {
    const headers = new Headers(getWorkerWakeHeaders("Bearer user-token"));

    expect(headers.get("authorization")).toBe("Bearer user-token");
  });

  it("builds a Supabase worker drain URL from the caller request host", () => {
    const url = getWorkerDrainUrl({
      requestUrl: "https://vohevknnbvpaooletyts.supabase.co/functions/v1/sources/v1/account/status",
      batch: 12,
      budgetMs: 50000,
      lanes: ["ingest"],
    });

    expect(url).toBe("https://vohevknnbvpaooletyts.supabase.co/functions/v1/worker/drain?batch=12&budget_ms=50000&lanes=ingest");
  });

  it("ignores non-Supabase project URLs when building drain URLs", () => {
    const url = getWorkerDrainUrl({
      requestUrl: "https://lifeshot.lovable.app/sources",
      supabaseUrl: "https://vohevknnbvpaooletyts.supabase.co",
    });

    expect(url).toBe("https://vohevknnbvpaooletyts.supabase.co/functions/v1/worker/drain?batch=4&budget_ms=50000");
  });
});
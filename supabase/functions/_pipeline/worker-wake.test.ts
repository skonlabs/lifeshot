import { describe, expect, it } from "vitest";
import { getWorkerWakeHeaders } from "./worker-wake.ts";

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
});
import { createServerFn } from "@tanstack/react-start";

/** Dashboard counts — STUB. Reads from public.dashboard_counts view via RLS. */
export const getDashboard = createServerFn({ method: "GET" }).handler(async () => {
  return {
    total_assets: 0,
    total_videos: 0,
    connected_sources: 0,
    in_duplicate_groups: 0,
    at_risk_count: 0,
    last_sync_at: null as string | null,
  };
});
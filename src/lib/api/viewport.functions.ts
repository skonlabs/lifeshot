import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Memory Viewport Service — STUB.
 * Real impl reads timeline_windows.payload from Supabase (RLS scoped),
 * with Redis read-through cache keyed by (user_id, filters_hash, cursor).
 * Returns immediately renderable descriptors (blurhash + thumb URL).
 */

export interface ViewportItem {
  asset_id: string;
  capture_time: string;
  w: number;
  h: number;
  blurhash: string;
  dominant_color: string;
  thumb_url: string | null;
  next_quality_url: string | null;
  hydration: "thumb-cached" | "provider-short-lived" | "placeholder-only";
  source_badge: string[];
  duplicate_group_id: string | null;
}

export const getViewport = createServerFn({ method: "POST" })
  .inputValidator((input: { cursor?: string; pageSize?: number }) =>
    z
      .object({
        cursor: z.string().optional(),
        pageSize: z.number().min(1).max(120).default(60),
        filters: z
          .object({
            dateRange: z.tuple([z.string(), z.string()]).optional(),
            sources: z.array(z.string()).optional(),
            people: z.array(z.string()).optional(),
            places: z.array(z.string()).optional(),
            eventId: z.string().optional(),
          })
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // TODO: hit Redis viewport cache, fall back to timeline_windows in Postgres.
    return {
      items: [] as ViewportItem[],
      next_cursor: null as string | null,
      empty_reason: "no_sources_connected" as
        | "no_sources_connected"
        | "no_results"
        | "syncing",
      pageSize: data.pageSize,
    };
  });
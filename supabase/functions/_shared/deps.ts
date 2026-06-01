// Centralized deps so the Edge runtime imports one canonical version per pkg.
export { Hono } from "jsr:@hono/hono@4.6.14";
export type { Context, Next } from "jsr:@hono/hono@4.6.14";
export { cors } from "jsr:@hono/hono@4.6.14/cors";
export { createClient } from "jsr:@supabase/supabase-js@2";
export type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
export { z } from "npm:zod@3.23.8";
export type { ZodSchema, ZodTypeAny } from "npm:zod@3.23.8";

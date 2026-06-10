import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const inputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const responseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
});

const errorSchema = z.object({
  ok: z.literal(false),
  message: z.string(),
  status: z.number().nullable(),
  requestId: z.string().nullable(),
});

const successSchema = z.object({
  ok: z.literal(true),
  access_token: z.string(),
  refresh_token: z.string(),
});

export const signInWithPasswordServer = createServerFn({ method: "POST" })
  .inputValidator(inputSchema)
  .handler(async ({ data }) => {
    const supabaseUrl = process.env.SUPABASE_URL ?? "https://vohevknnbvpaooletyts.supabase.co";
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "sb_publishable_8DJ7KPaQ8JdG9-ZOqa30uw_pkc4pLpX";

    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        signal: AbortSignal.timeout(8_000),
        headers: {
          apikey: publishableKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: data.email,
          password: data.password,
        }),
      });

      const rawBody = await response.text();
      const payload = (() => {
        if (!rawBody) return null;
        try {
          return JSON.parse(rawBody);
        } catch {
          return null;
        }
      })();

      if (!response.ok) {
        const fallbackMessage = response.status >= 500
          ? "Supabase auth is temporarily unavailable. Please try again in a minute."
          : "Sign in failed";
        const message = typeof payload?.msg === "string"
          ? payload.msg
          : typeof payload?.error_description === "string"
            ? payload.error_description
            : typeof payload?.message === "string"
              ? payload.message
              : fallbackMessage;

        console.error("signInWithPasswordServer upstream error", {
          status: response.status,
          requestId: response.headers.get("sb-request-id"),
          bodyPreview: rawBody.slice(0, 300),
        });

        return errorSchema.parse({
          ok: false,
          message,
          status: response.status,
          requestId: response.headers.get("sb-request-id"),
        });
      }

      const session = responseSchema.parse(payload);
      return successSchema.parse({
        ok: true,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    } catch (error) {
      console.error("signInWithPasswordServer network error", error);
      return errorSchema.parse({
        ok: false,
        message: "Supabase auth is temporarily unavailable. Please try again in a minute.",
        status: null,
        requestId: null,
      });
    }
  });
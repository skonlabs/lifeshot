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

export const signInWithPasswordServer = createServerFn({ method: "POST" })
  .inputValidator(inputSchema)
  .handler(async ({ data }) => {
    const supabaseUrl = process.env.SUPABASE_URL ?? "https://vohevknnbvpaooletyts.supabase.co";
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "sb_publishable_8DJ7KPaQ8JdG9-ZOqa30uw_pkc4pLpX";

    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: data.email,
        password: data.password,
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = typeof payload?.msg === "string"
        ? payload.msg
        : typeof payload?.error_description === "string"
          ? payload.error_description
          : typeof payload?.message === "string"
            ? payload.message
            : "Sign in failed";
      throw new Error(message);
    }

    return responseSchema.parse(payload);
  });
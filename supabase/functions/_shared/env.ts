export const ENV = {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? Deno.env.get("PROJECT_URL") ?? "",
  SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? "",
  SUPABASE_SERVICE_ROLE_KEY:
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "",
  APP_REDIRECT_URL: Deno.env.get("APP_REDIRECT_URL") ?? "http://localhost:3000",
  ALLOWED_ORIGINS: (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(","),
};

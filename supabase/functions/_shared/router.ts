import { Hono, cors } from "./deps.ts";
import { ENV } from "./env.ts";
import { withRequestId } from "./observability.ts";
import { withAuth } from "./auth.ts";
import { sendError, ApiError } from "./errors.ts";

export function createApi(): Hono {
  const app = new Hono();
  app.use("*", cors({
    origin: ENV.ALLOWED_ORIGINS.includes("*") ? "*" : ENV.ALLOWED_ORIGINS,
    allowMethods: ["GET","POST","PATCH","DELETE","OPTIONS"],
    allowHeaders: ["Authorization","Content-Type","Idempotency-Key","x-request-id"],
    exposeHeaders: ["x-request-id"],
  }));
  app.use("*", withRequestId);
  app.onError((err, c) => sendError(c, err));
  app.notFound((c) => sendError(c, new ApiError("not_found", `${c.req.method} ${new URL(c.req.url).pathname} not found`)));
  return app;
}

export function authed(app: Hono) {
  app.use("*", withAuth);
  return app;
}

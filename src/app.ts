import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ApiError, errorBody } from "./core/errors.js";
import type { Deps } from "./deps.js";
import { adminApiRoutes } from "./routes/admin/api.js";
import { adminAuthRoutes } from "./routes/admin/auth.js";
import { adminPageRoutes } from "./routes/admin/pages.js";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1.js";

export function createApp(deps: Deps, opts: { getRemoteAddr?: (c: any) => string | null } = {}) {
  const app = new Hono();
  app.use("*", secureHeaders({ strictTransportSecurity: deps.config.secureCookies ? "max-age=31536000; includeSubDomains" : false }));

  app.route("/", healthRoutes(deps));
  app.route("/v1", v1Routes(deps, opts.getRemoteAddr));
  app.route("/admin/auth", adminAuthRoutes(deps, opts.getRemoteAddr));
  app.route("/admin/api", adminApiRoutes(deps));
  app.route("/admin", adminPageRoutes(deps));

  app.notFound((c) => c.json(errorBody(new ApiError("not_found")), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err), err.status as any);
    }
    deps.logger.error("unhandled error", { path: c.req.path, error: String(err) });
    return c.json(errorBody(new ApiError("internal")), 500);
  });
  return app;
}

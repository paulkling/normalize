import { Hono } from "hono";
import type { Deps } from "../deps.js";

export function healthRoutes(deps: Deps) {
  const app = new Hono();
  app.get("/healthz", async (c) => {
    const inference = await deps.inference.healthy();
    let database = true;
    try {
      await deps.repos.settings.get();
    } catch {
      database = false;
    }
    const ok = inference && database;
    return c.json({ status: ok ? "ok" : "degraded", inference, database, model_revision: deps.config.modelRevision }, ok ? 200 : 503);
  });
  return app;
}

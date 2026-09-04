import { Hono } from "hono";
import type { Deps } from "../deps.js";
import { buildPublishedSchema } from "../schema/normalize.js";
import { INVALID_JSON, NormalizeService } from "../services/normalize.js";

export function clientIp(headers: Headers, fallback: string | null): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? fallback;
}

export function v1Routes(deps: Deps, getRemoteAddr: (c: any) => string | null = () => null) {
  const app = new Hono();
  const service = new NormalizeService(deps);

  app.post("/normalize", async (c) => {
    let body: unknown = INVALID_JSON;
    const raw = await c.req.text();
    if (raw.trim() === "") body = undefined;
    else {
      try {
        body = JSON.parse(raw);
      } catch {
        body = INVALID_JSON;
      }
    }
    const outcome = await service.handle({
      authorization: c.req.header("authorization"),
      idempotencyKey: c.req.header("idempotency-key"),
      body,
      ip: clientIp(c.req.raw.headers, getRemoteAddr(c)),
      userAgent: c.req.header("user-agent") ?? null,
    });
    for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
    return c.json(outcome.body, outcome.status as any);
  });

  app.get("/schema", async (c) => {
    const settings = await deps.repos.settings.get();
    return c.json(buildPublishedSchema(settings.max_transcript_chars));
  });

  return app;
}

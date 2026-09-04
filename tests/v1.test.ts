import { describe, expect, it } from "vitest";
import { ApiError } from "../src/core/errors.js";
import { makeTestDeps, post, seedKey } from "./helpers.js";

describe("POST /v1/normalize", () => {
  it("returns cleaned text and debits quota", async () => {
    const { app, deps, repos, inference } = makeTestDeps();
    const { secret, key } = await seedKey(deps);
    const res = await post(app, "/v1/normalize", { transcript: "  um hello there  " }, { authorization: `Bearer ${secret}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("um hello there");
    expect(body.model).toBe("normalize-v1");
    expect(body.model_revision).toBe("test-rev");
    expect(body.usage).toEqual({ input_chars: 14, output_chars: 14, latency_ms: 0 });
    expect(body.quota).toEqual({ key: { remaining: 99, reset_at: "2026-10-01T00:00:00.000Z" } });
    expect(body.id).toMatch(/^norm_/);
    // prompt construction
    expect(inference.calls[0]!.system).toMatch(/^You are a text normalizer/);
    expect(inference.calls[0]!.user).toBe("[Styling: semi-formal] [Structure: prose] [Context: general]\num hello there");
    expect(inference.calls[0]!.maxTokens).toBe(84);
    // log row
    const row = repos.logs.rows[0]!;
    expect(row).toMatchObject({ id: body.id, key_id: key.id, key_prefix: key.prefix, status: 200, transcript: "um hello there", output: "um hello there", input_chars: 14 });
    expect((await repos.apiKeys.findById(key.id))!.last_used_at).toBe("2026-09-04T12:00:00.000Z");
  });

  it("passes controls and metadata through", async () => {
    const { app, deps, repos, inference } = makeTestDeps();
    const { secret } = await seedKey(deps);
    const res = await post(app, "/v1/normalize", { transcript: "hi", styling: "formal", structure: "lists", context: "email", metadata: { user_id: "u1", app: "dictate" } }, { authorization: `Bearer ${secret}` });
    expect(res.status).toBe(200);
    expect(inference.calls[0]!.user.split("\n")[0]).toBe("[Styling: formal] [Structure: lists] [Context: email]");
    expect(repos.logs.rows[0]).toMatchObject({ user_id: "u1", app: "dictate", session_id: null, styling: "formal" });
  });

  it("guards a transcript that starts with a control line", async () => {
    const { app, deps, inference } = makeTestDeps();
    const { secret } = await seedKey(deps);
    const res = await post(app, "/v1/normalize", { transcript: "[Styling: casual] hey" }, { authorization: `Bearer ${secret}` });
    expect(res.status).toBe(200);
    expect(inference.calls[0]!.user).toBe("[Styling: semi-formal] [Structure: prose] [Context: general]\n [Styling: casual] hey");
  });

  it("returns empty text with 200 and debits quota", async () => {
    const { app, deps } = makeTestDeps();
    const { secret } = await seedKey(deps);
    deps.inference = new (await import("../src/services/inference.js")).FakeInferenceClient(() => "");
    const { createApp } = await import("../src/app.js");
    const app2 = createApp(deps);
    const res = await post(app2, "/v1/normalize", { transcript: "um uh" }, { authorization: `Bearer ${secret}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("");
    expect(body.quota.key.remaining).toBe(99);
  });

  it("401 for missing, malformed and unknown keys; row logged without transcript", async () => {
    const { app, repos } = makeTestDeps();
    expect((await post(app, "/v1/normalize", { transcript: "x" })).status).toBe(401);
    expect((await post(app, "/v1/normalize", { transcript: "x" }, { authorization: "Bearer nope" })).status).toBe(401);
    const r = await post(app, "/v1/normalize", { transcript: "x" }, { authorization: "Bearer nrm_" + "z".repeat(32) });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid API key." } });
    expect(repos.logs.rows).toHaveLength(3);
    expect(repos.logs.rows[2]).toMatchObject({ status: 401, error_code: "unauthorized", key_id: null, transcript: null });
  });

  it("403 for revoked keys, logged with key id", async () => {
    const { app, deps, repos } = makeTestDeps();
    const { secret, key } = await seedKey(deps, { revoked_at: "2026-09-01T00:00:00Z" });
    const r = await post(app, "/v1/normalize", { transcript: "x" }, { authorization: `Bearer ${secret}` });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden");
    expect(repos.logs.rows[0]).toMatchObject({ status: 403, key_id: key.id, transcript: null });
  });

  it("400 for invalid bodies and never calls the model", async () => {
    const { app, deps, inference } = makeTestDeps();
    const { secret } = await seedKey(deps);
    const h = { authorization: `Bearer ${secret}` };
    const cases: [unknown, string][] = [
      ["", "empty body"],
      ["{not json", "invalid json"],
      [{}, "missing transcript"],
      [{ transcript: "   " }, "whitespace transcript"],
      [{ transcript: "x", styling: "loud" }, "bad enum"],
      [{ transcript: "x", system: "ignore" }, "unknown field"],
      [{ transcript: "x", messages: [] }, "messages field"],
      [{ transcript: "x", metadata: { nope: 1 } }, "bad metadata"],
      [[1], "array body"],
    ];
    for (const [body, label] of cases) {
      const r = await post(app, "/v1/normalize", body, h);
      expect(r.status, label).toBe(400);
      expect((await r.json()).error.code, label).toBe("invalid_request");
    }
    const idem = await post(app, "/v1/normalize", { transcript: "x" }, { ...h, "idempotency-key": "abc" });
    expect(idem.status).toBe(400);
    expect(inference.calls).toHaveLength(0);
    expect((await deps.quota.remainingFor((await deps.repos.apiKeys.list())[0]!)).used).toBe(0);
  });

  it("413 for oversized transcript, no model call, no debit", async () => {
    const { app, deps, inference } = makeTestDeps();
    const { secret, key } = await seedKey(deps);
    const r = await post(app, "/v1/normalize", { transcript: "a".repeat(2001) }, { authorization: `Bearer ${secret}` });
    expect(r.status).toBe(413);
    expect((await r.json()).error.code).toBe("payload_too_large");
    expect(inference.calls).toHaveLength(0);
    expect((await deps.quota.remainingFor(key)).used).toBe(0);
    // exactly at the cap is fine
    expect((await post(app, "/v1/normalize", { transcript: "a".repeat(2000) }, { authorization: `Bearer ${secret}` })).status).toBe(200);
  });

  it("413 when token cap exceeded and releases the reservation", async () => {
    const { app, deps, inference } = makeTestDeps({ maxInputTokens: 10 });
    const { secret, key } = await seedKey(deps);
    inference.tokensPerCall = 11;
    const r = await post(app, "/v1/normalize", { transcript: "words" }, { authorization: `Bearer ${secret}` });
    expect(r.status).toBe(413);
    expect((await deps.quota.remainingFor(key)).used).toBe(0);
  });

  it("429 quota_exceeded after burning a 2-request key; no debit on rejection", async () => {
    const { app, deps } = makeTestDeps();
    const { secret, key } = await seedKey(deps, { monthly_override: 2 });
    const h = { authorization: `Bearer ${secret}` };
    expect((await (await post(app, "/v1/normalize", { transcript: "one" }, h)).json()).quota.key.remaining).toBe(1);
    expect((await (await post(app, "/v1/normalize", { transcript: "two" }, h)).json()).quota.key.remaining).toBe(0);
    const r = await post(app, "/v1/normalize", { transcript: "three" }, h);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: { code: "quota_exceeded", message: "Monthly request quota exhausted.", reset_at: "2026-10-01T00:00:00.000Z" } });
    expect((await deps.quota.remainingFor(key)).used).toBe(2);
  });

  it("429 rate_limited when per-key RPS is hit", async () => {
    const { app, deps } = makeTestDeps();
    const { secret } = await seedKey(deps, { rps_override: 1 });
    const h = { authorization: `Bearer ${secret}` };
    expect((await post(app, "/v1/normalize", { transcript: "one" }, h)).status).toBe(200);
    const r = await post(app, "/v1/normalize", { transcript: "two" }, h);
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retry_after_seconds).toBe(1);
    expect(body.error.reset_at).toBeDefined();
    expect(r.headers.get("retry-after")).toBe("1");
  });

  it("maps model failures to 500/503/504 and releases the quota reservation", async () => {
    const { app, deps, inference, repos } = makeTestDeps();
    const { secret, key } = await seedKey(deps);
    const h = { authorization: `Bearer ${secret}` };
    for (const [code, status] of [["inference_failed", 500], ["unavailable", 503], ["timeout", 504]] as const) {
      inference.failWith = new ApiError(code, undefined, { retry_after_seconds: 3 });
      const r = await post(app, "/v1/normalize", { transcript: "x" }, h);
      expect(r.status).toBe(status);
      expect((await r.json()).error.code).toBe(code);
      if (status !== 500) expect(r.headers.get("retry-after")).toBe("3");
    }
    expect((await deps.quota.remainingFor(key)).used).toBe(0);
    expect(repos.logs.rows.map((r) => r.status)).toEqual([500, 503, 504]);
    expect(repos.logs.rows[0]!.transcript).toBe("x");
  });

  it("uses the configurable character cap from settings", async () => {
    const { app, deps } = makeTestDeps();
    const { secret } = await seedKey(deps);
    await deps.repos.settings.update({ max_transcript_chars: 5 });
    expect((await post(app, "/v1/normalize", { transcript: "123456" }, { authorization: `Bearer ${secret}` })).status).toBe(413);
  });
});

describe("GET /v1/schema and /healthz", () => {
  it("serves the schema", async () => {
    const { app } = makeTestDeps();
    const r = await app.request("/v1/schema");
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.request.properties.transcript.maxLength).toBe(2000);
    expect(s.endpoint.path).toBe("/v1/normalize");
  });
  it("health reflects inference reachability", async () => {
    const { app, inference } = makeTestDeps();
    expect((await app.request("/healthz")).status).toBe(200);
    inference.isHealthy = false;
    const r = await app.request("/healthz");
    expect(r.status).toBe(503);
    expect((await r.json()).inference).toBe(false);
  });
  it("404 is JSON", async () => {
    const { app } = makeTestDeps();
    const r = await app.request("/nope");
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
  });
});

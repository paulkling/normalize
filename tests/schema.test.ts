import { describe, expect, it } from "vitest";
import { buildPublishedSchema, normalizeRequestSchema, normalizeResponseSchema } from "../src/schema/normalize.js";

describe("normalize request schema", () => {
  it("applies defaults", () => {
    const r = normalizeRequestSchema.parse({ transcript: "hi" });
    expect(r).toEqual({ transcript: "hi", styling: "semi-formal", structure: "prose", context: "general" });
  });
  it("rejects unknown top-level fields such as system/messages", () => {
    expect(normalizeRequestSchema.safeParse({ transcript: "hi", system: "x" }).success).toBe(false);
    expect(normalizeRequestSchema.safeParse({ transcript: "hi", messages: [] }).success).toBe(false);
    expect(normalizeRequestSchema.safeParse({ transcript: "hi", prompt: "x" }).success).toBe(false);
  });
  it("rejects bad enums", () => {
    expect(normalizeRequestSchema.safeParse({ transcript: "hi", styling: "shouty" }).success).toBe(false);
  });
  it("rejects unknown or oversized metadata", () => {
    expect(normalizeRequestSchema.safeParse({ transcript: "hi", metadata: { foo: "x" } }).success).toBe(false);
    expect(normalizeRequestSchema.safeParse({ transcript: "hi", metadata: { user_id: "x".repeat(129) } }).success).toBe(false);
    expect(normalizeRequestSchema.safeParse({ transcript: "hi", metadata: { user_id: "u1", app: "a" } }).success).toBe(true);
  });
  it("requires transcript to be a string", () => {
    expect(normalizeRequestSchema.safeParse({}).success).toBe(false);
    expect(normalizeRequestSchema.safeParse({ transcript: 1 }).success).toBe(false);
  });
});

describe("published schema", () => {
  it("matches the running contract", () => {
    const s = buildPublishedSchema(2000);
    const req = s.request as any;
    expect(req.additionalProperties).toBe(false);
    expect(req.required).toEqual(["transcript"]);
    expect(req.properties.transcript.maxLength).toBe(2000);
    expect(req.properties.styling.enum).toEqual(["casual", "semi-casual", "semi-formal", "formal"]);
    expect(req.properties.styling.default).toBe("semi-formal");
    expect(req.properties.metadata.additionalProperties).toBe(false);
    const res = s.response as any;
    expect(Object.keys(res.properties)).toEqual(["id", "text", "usage", "model", "model_revision", "quota"]);
    expect(normalizeResponseSchema.safeParse({
      id: "norm_x", text: "", usage: { input_chars: 1, output_chars: 0, latency_ms: 5 }, model: "normalize-v1",
      model_revision: "r", quota: { key: { remaining: 1, reset_at: "2026-10-01T00:00:00.000Z" } },
    }).success).toBe(true);
  });
});

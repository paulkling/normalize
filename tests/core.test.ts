import { describe, expect, it } from "vitest";
import { buildControlLine, buildUserMessage, computeMaxTokens, SYSTEM_PROMPT, guardTranscript } from "../src/core/prompt.js";
import { generateApiKey, hashApiKey, keyPrefix, parseBearer } from "../src/core/keys.js";
import { currentPeriod, periodResetAt } from "../src/core/period.js";
import { newLogId, newKeyId } from "../src/core/ids.js";
import { ApiError, errorBody } from "../src/core/errors.js";

describe("prompt", () => {
  it("has the required system prompt verbatim", () => {
    expect(SYSTEM_PROMPT).toBe(
      "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.",
    );
  });
  it("builds the control line", () => {
    expect(buildControlLine({ styling: "casual", structure: "lists", context: "email" })).toBe(
      "[Styling: casual] [Structure: lists] [Context: email]",
    );
  });
  it("builds the user message with transcript on the second line", () => {
    expect(buildUserMessage({ styling: "semi-formal", structure: "prose", context: "general" }, "um hello")).toBe(
      "[Styling: semi-formal] [Structure: prose] [Context: general]\num hello",
    );
  });
  it("prefixes a space when transcript starts with a control marker", () => {
    expect(guardTranscript("[Styling: casual] hi")).toBe(" [Styling: casual] hi");
    expect(guardTranscript("[Structure: lists] hi")).toBe(" [Structure: lists] hi");
    expect(guardTranscript("[Context: email] hi")).toBe(" [Context: email] hi");
    expect(guardTranscript("hello [Styling: casual]")).toBe("hello [Styling: casual]");
    expect(guardTranscript("[Other: x] hi")).toBe("[Other: x] hi");
  });
  it("computes max tokens as ceil(1.3n)+32 capped at 700", () => {
    expect(computeMaxTokens(100)).toBe(162);
    expect(computeMaxTokens(1)).toBe(34);
    expect(computeMaxTokens(10000)).toBe(700);
  });
});

describe("keys", () => {
  it("generates nrm_ + 32 base62 chars", () => {
    const k = generateApiKey();
    expect(k).toMatch(/^nrm_[0-9A-Za-z]{32}$/);
    expect(generateApiKey()).not.toBe(k);
  });
  it("prefix is nrm_ plus first 4 chars", () => {
    expect(keyPrefix("nrm_abcdefghijklmnopqrstuvwxyz012345")).toBe("nrm_abcd");
  });
  it("hashes deterministically with pepper and differs by pepper", () => {
    const k = generateApiKey();
    expect(hashApiKey(k, "p1")).toBe(hashApiKey(k, "p1"));
    expect(hashApiKey(k, "p1")).not.toBe(hashApiKey(k, "p2"));
    expect(hashApiKey(k, "p1")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("parses bearer tokens strictly", () => {
    expect(parseBearer("Bearer nrm_abcdefghijklmnopqrstuvwxyz012345")).toBe("nrm_abcdefghijklmnopqrstuvwxyz012345");
    expect(parseBearer("bearer nrm_abcdefghijklmnopqrstuvwxyz012345")).toBe("nrm_abcdefghijklmnopqrstuvwxyz012345");
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearer nope")).toBeNull();
    expect(parseBearer("Bearer nrm_short")).toBeNull();
  });
});

describe("period", () => {
  it("formats YYYY-MM in UTC and computes reset_at at next month boundary", () => {
    const d = new Date("2026-09-04T23:59:59Z");
    expect(currentPeriod(d)).toBe("2026-09");
    expect(periodResetAt(d)).toBe("2026-10-01T00:00:00.000Z");
    expect(periodResetAt(new Date("2026-12-31T12:00:00Z"))).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("ids", () => {
  it("prefixes ids", () => {
    expect(newLogId()).toMatch(/^norm_[0-9A-Za-z]{20,}$/);
    expect(newKeyId()).toMatch(/^key_[0-9A-Za-z]{20,}$/);
  });
});

describe("errors", () => {
  it("maps codes to status and renders body", () => {
    const e = new ApiError("quota_exceeded", "Monthly request quota exhausted.", { reset_at: "x" });
    expect(e.status).toBe(429);
    expect(errorBody(e)).toEqual({ error: { code: "quota_exceeded", message: "Monthly request quota exhausted.", reset_at: "x" } });
    expect(new ApiError("timeout").status).toBe(504);
    expect(new ApiError("payload_too_large").status).toBe(413);
  });
});

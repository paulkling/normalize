import { describe, expect, it } from "vitest";
import { loadEnv, toAppConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://x", KEY_PEPPER: "p".repeat(16), IP_HMAC_SECRET: "i".repeat(16), SESSION_SECRET: "s".repeat(32) };

describe("config", () => {
  it("requires supabase settings unless the fake provider is selected", () => {
    expect(() => loadEnv({ ...base })).toThrow(/SUPABASE_URL/);
    expect(loadEnv({ ...base, IDENTITY_PROVIDER: "fake" }).IDENTITY_PROVIDER).toBe("fake");
    expect(() => loadEnv({ ...base, IDENTITY_PROVIDER: "fake", NODE_ENV: "production" })).toThrow(/production/);
    const env = loadEnv({ ...base, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", PUBLIC_URL: "https://n.example.com/" });
    const cfg = toAppConfig(env);
    expect(cfg.secureCookies).toBe(true);
    expect(cfg.publicUrl).toBe("https://n.example.com");
    expect(cfg.maxInputTokens).toBe(500);
    expect(cfg.inferenceTimeoutMs).toBe(15000);
  });
  it("reports missing secrets clearly", () => {
    expect(() => loadEnv({ DATABASE_URL: "x" })).toThrow(/KEY_PEPPER/);
  });
});

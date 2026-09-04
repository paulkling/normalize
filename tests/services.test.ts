import { describe, expect, it } from "vitest";
import { createMemoryRepos } from "../src/repos/memory.js";
import { KeyAuthService } from "../src/services/keyAuth.js";
import { QuotaService } from "../src/services/quota.js";
import { generateApiKey, hashApiKey, keyPrefix } from "../src/core/keys.js";
import { newKeyId } from "../src/core/ids.js";
import type { ApiKey } from "../src/repos/types.js";

function makeKey(repos: ReturnType<typeof createMemoryRepos>, pepper = "pep", overrides: Partial<ApiKey> = {}) {
  const secret = generateApiKey();
  const key: ApiKey = {
    id: newKeyId(), prefix: keyPrefix(secret), secret_hash: hashApiKey(secret, pepper), name: "t", owner_email: null, notes: null,
    created_at: new Date().toISOString(), created_by: null, last_used_at: null, revoked_at: null, plan_id: "default",
    monthly_override: null, rps_override: null, ...overrides,
  };
  repos.apiKeys.keys.set(key.id, key);
  return { secret, key };
}

describe("KeyAuthService", () => {
  it("authenticates, caches, and invalidates on revoke", async () => {
    const repos = createMemoryRepos();
    let t = 1_000_000;
    const auth = new KeyAuthService(repos.apiKeys, "pep", 60_000, () => t);
    const { secret, key } = makeKey(repos);
    expect((await auth.authenticate(`Bearer ${secret}`)).id).toBe(key.id);
    // Revoke in the repo without touching the cached object: the cache still serves the stale active copy...
    repos.apiKeys.keys.set(key.id, { ...key, revoked_at: new Date().toISOString() });
    const cached = await auth.authenticate(`Bearer ${secret}`);
    expect(cached.id).toBe(key.id);
    // ...but an explicit invalidate makes the repo state visible immediately.
    auth.invalidate(key.id);
    await expect(auth.authenticate(`Bearer ${secret}`)).rejects.toMatchObject({ code: "forbidden" });
    // and TTL expiry refreshes too
    t += 61_000;
    await expect(auth.authenticate(`Bearer ${secret}`)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects unknown and malformed", async () => {
    const repos = createMemoryRepos();
    const auth = new KeyAuthService(repos.apiKeys, "pep");
    await expect(auth.authenticate(undefined)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(auth.authenticate("Bearer nrm_" + "a".repeat(32))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(auth.authenticate("Bearer garbage")).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("QuotaService", () => {
  it("reserves until the limit and reports reset_at", async () => {
    const repos = createMemoryRepos();
    const q = new QuotaService(repos.quotaUsage, repos.quotaPlans, repos.settings, () => new Date("2026-09-04T10:00:00Z"));
    const { key } = makeKey(repos, "pep", { monthly_override: 2 });
    const limits = await q.limitsFor(key);
    expect(limits).toEqual({ monthly: 2, rps: 5 });
    expect((await q.reserve(key, 2)).remaining).toBe(1);
    expect((await q.reserve(key, 2)).remaining).toBe(0);
    await expect(q.reserve(key, 2)).rejects.toMatchObject({ code: "quota_exceeded", extras: { reset_at: "2026-10-01T00:00:00.000Z" } });
    await q.release(key, "2026-09");
    expect((await q.reserve(key, 2)).remaining).toBe(0);
  });
  it("enforces rps with a sliding window", () => {
    const repos = createMemoryRepos();
    let ms = 0;
    const q = new QuotaService(repos.quotaUsage, repos.quotaPlans, repos.settings, () => new Date(ms));
    q.checkRps("k", 2);
    q.checkRps("k", 2);
    expect(() => q.checkRps("k", 2)).toThrow(/Too many/);
    ms = 1001;
    expect(() => q.checkRps("k", 2)).not.toThrow();
  });
});

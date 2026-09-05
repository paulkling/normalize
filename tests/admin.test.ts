import { describe, expect, it } from "vitest";
import { makeTestDeps, post, seedKey } from "./helpers.js";
import { Client, login, seedAdmin } from "./adminHelpers.js";

const SUPER = "pkling@brainsprung.com";

describe("admin auth", () => {
  it("returns the same response for allowlisted and unknown emails, but only sends links to allowlisted", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const c = new Client(t.app);
    await c.primeCsrf();
    const a = await c.fetch("/admin/auth/login", { method: "POST", json: { email: SUPER } });
    const b = await c.fetch("/admin/auth/login", { method: "POST", json: { email: "stranger@example.com" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect(t.identity.sentLinks.map((l) => l.email)).toEqual([SUPER]);
    expect(t.identity.sentLinks[0]!.redirectTo).toBe("http://localhost:3000/admin/auth/callback");
    // auth user provisioned lazily
    expect((await t.repos.allowlist.findByEmail(SUPER))!.auth_user_id).toBe("user_1");
  });

  it("requires CSRF on login and rate-limits per email", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const c = new Client(t.app);
    expect((await c.fetch("/admin/auth/login", { method: "POST", json: { email: SUPER } })).status).toBe(403);
    await c.primeCsrf();
    for (let i = 0; i < 5; i++) expect((await c.fetch("/admin/auth/login", { method: "POST", json: { email: SUPER } })).status).toBe(200);
    expect((await c.fetch("/admin/auth/login", { method: "POST", json: { email: SUPER } })).status).toBe(429);
    expect((await c.fetch("/admin/auth/login", { method: "POST", json: { email: "not-an-email" } })).status).toBe(400);
  });

  it("logs in via callback, sets a session, and audits", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const c = await login(t, SUPER);
    expect(c.cookies.has("nrm_admin")).toBe(true);
    const me = await c.fetch("/admin/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: SUPER, role: "super_admin", can_view_transcripts: true });
    expect(t.repos.audit.events.map((e) => e.action)).toContain("auth.login");
    expect((await t.repos.allowlist.findByEmail(SUPER))!.last_login_at).toBe("2026-09-04T12:00:00.000Z");
  });

  it("rejects invalid or reused links and non-allowlisted callbacks", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const c = new Client(t.app);
    const bad = await c.fetch("/admin/auth/callback?token_hash=nope&type=magiclink");
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toMatch(/^\/admin\/login\?reason=/);
    expect(c.cookies.has("nrm_admin")).toBe(false);
    // removed from allowlist between link and click
    await c.primeCsrf();
    await c.fetch("/admin/auth/login", { method: "POST", json: { email: SUPER } });
    const entry = (await t.repos.allowlist.findByEmail(SUPER))!;
    await t.repos.allowlist.update(entry.id, { disabled_at: "2026-09-04T12:01:00Z" });
    const cb = await c.fetch(`/admin/auth/callback?token_hash=${t.identity.sentLinks[0]!.tokenHash}&type=magiclink`);
    expect(cb.headers.get("location")).toContain("does%20not%20have%20access");
    expect(c.cookies.has("nrm_admin")).toBe(false);
  });

  it("unauthenticated API returns 401 and pages redirect", async () => {
    const t = makeTestDeps();
    const c = new Client(t.app);
    expect((await c.fetch("/admin/api/keys")).status).toBe(401);
    const page = await c.fetch("/admin");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toMatch(/^\/admin\/login/);
  });

  it("removing or disabling an allowlist entry takes effect on the next request", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const admin = await seedAdmin(t, "bob@brainsprung.com", "admin");
    const c = await login(t, "bob@brainsprung.com");
    expect((await c.fetch("/admin/api/keys")).status).toBe(200);
    await t.repos.allowlist.update(admin.id, { disabled_at: "2026-09-04T12:00:01Z" });
    expect((await c.fetch("/admin/api/keys")).status).toBe(403);
  });

  it("refreshes expired access tokens and enforces the 30-day maximum", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    t.identity.clock = () => Math.floor(t.clock().getTime() / 1000);
    const c = await login(t, SUPER);
    const before = c.cookies.get("nrm_admin");
    t.setNow(new Date("2026-09-05T12:00:00Z")); // access token (1h) expired, refresh works
    expect((await c.fetch("/admin/api/me")).status).toBe(200);
    expect(c.cookies.get("nrm_admin")).not.toBe(before);
    t.setNow(new Date("2026-10-06T12:00:00Z")); // > 30 days since login
    expect((await c.fetch("/admin/api/me")).status).toBe(401);
    expect(c.cookies.has("nrm_admin")).toBe(false);
  });

  it("logout clears the session", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const c = await login(t, SUPER);
    expect((await c.fetch("/admin/auth/logout", { method: "POST" })).status).toBe(200);
    expect(c.cookies.has("nrm_admin")).toBe(false);
    expect((await c.fetch("/admin/api/me")).status).toBe(401);
  });
});

describe("admin API", () => {
  it("enforces CSRF on mutations", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const c = await login(t, SUPER);
    const r = await c.fetch("/admin/api/keys", { method: "POST", json: { name: "x" }, headers: { "x-csrf-token": "wrong" } });
    expect(r.status).toBe(403);
    expect((await c.fetch("/admin/api/keys", { method: "POST", json: { name: "x" } })).status).toBe(201);
  });

  it("creates a key, reveals the secret once, and the key works against /v1", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const c = await login(t, SUPER);
    const r = await c.fetch("/admin/api/keys", { method: "POST", json: { name: "dictation", owner_email: "team@brainsprung.com", monthly_override: 2, rps_override: 3 } });
    expect(r.status).toBe(201);
    const { key, secret } = await r.json();
    expect(secret).toMatch(/^nrm_[0-9A-Za-z]{32}$/);
    expect(key.prefix).toBe(secret.slice(0, 8));
    expect(key.secret_hash).toBeUndefined();
    expect(key.created_by).toBe(SUPER);
    const list = await (await c.fetch("/admin/api/keys")).json();
    expect(list.keys[0]).toMatchObject({ id: key.id, usage: { used: 0, limit: 2, remaining: 2 } });
    expect(JSON.stringify(list)).not.toContain(secret);
    const ok = await post(t.app, "/v1/normalize", { transcript: "hi" }, { authorization: `Bearer ${secret}` });
    expect(ok.status).toBe(200);
    const detail = await (await c.fetch(`/admin/api/keys/${key.id}`)).json();
    expect(detail.usage.used).toBe(1);
    expect(detail.recent_logs).toHaveLength(1);
    expect(detail.recent_logs[0].redacted).toBe(true);
    expect(detail.recent_logs[0].transcript).toBeUndefined();
    expect(t.repos.audit.events.map((e) => e.action)).toContain("key.create");
  });

  it("revokes a key immediately despite the auth cache", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const c = await login(t, SUPER);
    const { key, secret } = await (await c.fetch("/admin/api/keys", { method: "POST", json: { name: "k" } })).json();
    expect((await post(t.app, "/v1/normalize", { transcript: "hi" }, { authorization: `Bearer ${secret}` })).status).toBe(200);
    expect((await c.fetch(`/admin/api/keys/${key.id}/revoke`, { method: "POST" })).status).toBe(200);
    expect((await post(t.app, "/v1/normalize", { transcript: "hi" }, { authorization: `Bearer ${secret}` })).status).toBe(403);
    // and overrides apply immediately too
    const { key: k2, secret: s2 } = await (await c.fetch("/admin/api/keys", { method: "POST", json: { name: "k2" } })).json();
    expect((await post(t.app, "/v1/normalize", { transcript: "hi" }, { authorization: `Bearer ${s2}` })).status).toBe(200);
    await c.fetch(`/admin/api/keys/${k2.id}`, { method: "PATCH", json: { monthly_override: 1 } });
    expect((await post(t.app, "/v1/normalize", { transcript: "hi" }, { authorization: `Bearer ${s2}` })).status).toBe(429);
  });

  it("gates transcripts on can_view_transcripts and audits reads", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    await seedAdmin(t, "bob@brainsprung.com", "admin");
    const { secret } = await seedKey(t.deps);
    await post(t.app, "/v1/normalize", { transcript: "secret words", metadata: { user_id: "u9" } }, { authorization: `Bearer ${secret}` });
    const id = t.repos.logs.rows[0]!.id;

    const bob = await login(t, "bob@brainsprung.com");
    const list = await (await bob.fetch("/admin/api/logs")).json();
    expect(list.logs).toHaveLength(1);
    expect(list.can_view_transcripts).toBe(false);
    expect(JSON.stringify(list)).not.toContain("secret words");
    const detail = await (await bob.fetch(`/admin/api/logs/${id}`)).json();
    expect(detail.log.redacted).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("secret words");
    expect(t.repos.audit.events.filter((e) => e.action === "log.view_transcript")).toHaveLength(0);

    const paul = await login(t, SUPER);
    const full = await (await paul.fetch(`/admin/api/logs/${id}`)).json();
    expect(full.log).toMatchObject({ redacted: false, transcript: "secret words", output: "secret words", user_id: "u9" });
    const views = t.repos.audit.events.filter((e) => e.action === "log.view_transcript");
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ actor_email: SUPER, target: id });
    // list never contains transcripts even for permitted users; filters work
    const filtered = await (await paul.fetch(`/admin/api/logs?user_id=u9&status=200`)).json();
    expect(filtered.logs).toHaveLength(1);
    expect(JSON.stringify(filtered)).not.toContain("secret words");
    expect((await (await paul.fetch(`/admin/api/logs?user_id=nobody`)).json()).logs).toHaveLength(0);
    expect((await paul.fetch(`/admin/api/logs?from=bad`)).status).toBe(400);
  });

  it("restricts allowlist management to super_admin and protects the last super-admin", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    await seedAdmin(t, "bob@brainsprung.com", "admin");
    const bob = await login(t, "bob@brainsprung.com");
    expect((await bob.fetch("/admin/api/allowlist")).status).toBe(403);
    expect((await bob.fetch("/admin/api/allowlist", { method: "POST", json: { email: "eve@x.com" } })).status).toBe(403);

    const paul = await login(t, SUPER);
    const created = await paul.fetch("/admin/api/allowlist", { method: "POST", json: { email: "Carol@Brainsprung.com", role: "admin" } });
    expect(created.status).toBe(201);
    const { entry } = await created.json();
    expect(entry).toMatchObject({ email: "carol@brainsprung.com", role: "admin", can_view_transcripts: false, invited_by: SUPER, auth_user_id: expect.stringMatching(/^user_/) });
    expect((await paul.fetch("/admin/api/allowlist", { method: "POST", json: { email: "carol@brainsprung.com" } })).status).toBe(400);

    // toggle transcript flag, then disable (revokes sessions)
    const carol = await login(t, "carol@brainsprung.com");
    expect((await paul.fetch(`/admin/api/allowlist/${entry.id}`, { method: "PATCH", json: { can_view_transcripts: true } })).status).toBe(200);
    expect((await (await carol.fetch("/admin/api/me")).json()).can_view_transcripts).toBe(true);
    expect((await paul.fetch(`/admin/api/allowlist/${entry.id}`, { method: "PATCH", json: { disabled: true } })).status).toBe(200);
    expect((await carol.fetch("/admin/api/me")).status).not.toBe(200);

    // self-protection and last super-admin
    const me = (await t.repos.allowlist.findByEmail(SUPER))!;
    expect((await paul.fetch(`/admin/api/allowlist/${me.id}`, { method: "PATCH", json: { role: "admin" } })).status).toBe(400);
    expect((await paul.fetch(`/admin/api/allowlist/${me.id}`, { method: "DELETE" })).status).toBe(400);

    // remove carol: auth user deleted
    expect((await paul.fetch(`/admin/api/allowlist/${entry.id}`, { method: "DELETE" })).status).toBe(200);
    expect(t.identity.users.has("carol@brainsprung.com")).toBe(false);
    expect(await t.repos.allowlist.findByEmail("carol@brainsprung.com")).toBeNull();
    expect(t.repos.audit.events.map((e) => e.action)).toEqual(expect.arrayContaining(["allowlist.add", "allowlist.update", "allowlist.remove"]));
  });

  it("updates quotas and settings, and dashboard reports usage", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const paul = await login(t, SUPER);
    expect((await (await paul.fetch("/admin/api/quotas")).json()).plan).toMatchObject({ monthly_requests: 100, rps: 5 });
    expect((await paul.fetch("/admin/api/quotas", { method: "PATCH", json: { monthly_requests: 3 } })).status).toBe(200);
    expect((await paul.fetch("/admin/api/settings", { method: "PATCH", json: { retention_days: 45 } })).status).toBe(400);
    expect((await (await paul.fetch("/admin/api/settings", { method: "PATCH", json: { retention_days: 90, maintenance_banner: "Down at 5" } })).json()).settings).toMatchObject({ retention_days: 90, maintenance_banner: "Down at 5" });

    const { secret } = await (await paul.fetch("/admin/api/keys", { method: "POST", json: { name: "k" } })).json();
    await post(t.app, "/v1/normalize", { transcript: "a" }, { authorization: `Bearer ${secret}` });
    await post(t.app, "/v1/normalize", { transcript: "" }, { authorization: `Bearer ${secret}` });
    t.inference.failWith = new (await import("../src/core/errors.js")).ApiError("timeout");
    await post(t.app, "/v1/normalize", { transcript: "b" }, { authorization: `Bearer ${secret}` });
    const d = await (await paul.fetch("/admin/api/dashboard")).json();
    expect(d).toMatchObject({ period: "2026-09", requests_today: 3, errors_today: 1, requests_month: 3, quota_used: 1, quota_limit: 3, p95_latency_ms_today: 0 });
    expect(d.keys[0]).toMatchObject({ used: 1, limit: 3, remaining: 2 });
  });
});

describe("fake identity across restarts", () => {
  it("accepts a magic link when the allowlist row already has an auth_user_id from a previous process", async () => {
    const t = makeTestDeps();
    const entry = await seedAdmin(t, SUPER);
    await t.repos.allowlist.update(entry.id, { auth_user_id: "user_from_previous_process" });
    const c = await login(t, SUPER);
    expect((await c.fetch("/admin/api/me")).status).toBe(200);
  });
});

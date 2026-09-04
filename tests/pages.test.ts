import { describe, expect, it } from "vitest";
import { makeTestDeps, post, seedKey } from "./helpers.js";
import { Client, login, seedAdmin } from "./adminHelpers.js";

const SUPER = "pkling@brainsprung.com";

describe("admin pages", () => {
  it("login page renders with a CSRF meta tag and no session", async () => {
    const t = makeTestDeps();
    const c = new Client(t.app);
    const res = await c.primeCsrf();
    expect(res.status).toBe(200);
    expect(c.csrf).toBeTruthy();
    expect(c.cookies.has("nrm_csrf")).toBe(true);
    expect(await (await c.fetch("/admin/login?reason=Session%20expired")).text()).toContain("Session expired");
  });

  it("renders every page for a signed-in super-admin", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    const { secret, key } = await seedKey(t.deps, { name: "dictation-backend" });
    await post(t.app, "/v1/normalize", { transcript: "hello world", metadata: { user_id: "u1" } }, { authorization: `Bearer ${secret}` });
    await t.repos.settings.update({ maintenance_banner: "Maintenance Friday" });
    const c = await login(t, SUPER);
    for (const [path, needle] of [
      ["/admin", "September 2026"],
      ["/admin/keys", "dictation-backend"],
      [`/admin/keys/${key.id}`, "requests used this month"],
      ["/admin/logs", "hello"],
      ["/admin/logs?key_id=" + key.id + "&status=200&from=2026-09-01&to=2026-09-30", "nrm_"],
      ["/admin/quotas", "Default plan"],
      ["/admin/allowlist", SUPER],
      ["/admin/settings", "auth.login"],
    ] as const) {
      const res = await c.fetch(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain("Maintenance Friday");
      expect(html, path).toContain(`name="csrf-token" content="${c.csrf}"`);
      // "hello" only appears as the substring of nothing else; the transcript itself must never be server-rendered in lists
      if (path === "/admin/logs") expect(html).not.toContain("hello world");
      else expect(html, path).toContain(needle);
    }
    expect((await c.fetch("/admin/keys/key_missing")).status).toBe(404);
  });

  it("hides the allowlist from plain admins", async () => {
    const t = makeTestDeps();
    await seedAdmin(t, SUPER);
    await seedAdmin(t, "bob@brainsprung.com", "admin");
    const c = await login(t, "bob@brainsprung.com");
    const home = await (await c.fetch("/admin")).text();
    expect(home).not.toContain('href="/admin/allowlist"');
    expect(home).toContain("Admin");
    const r = await c.fetch("/admin/allowlist");
    expect(r.status).toBe(302);
  });
});

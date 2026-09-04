import type { Hono } from "hono";
import { makeTestDeps } from "./helpers.js";

/** Tiny cookie jar for driving the admin app through app.request(). */
export class Client {
  cookies = new Map<string, string>();
  csrf: string | null = null;
  constructor(private readonly app: Hono<any>) {}

  private absorb(res: Response) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(";");
      const [name, ...v] = pair!.split("=");
      const value = v.join("=");
      const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith("max-age="));
      if (maxAge && maxAge.endsWith("=0")) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
  }

  async fetch(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers ?? {});
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(init.json);
    }
    if (init.method && init.method !== "GET" && this.csrf && !headers.has("x-csrf-token")) headers.set("x-csrf-token", this.csrf);
    const res = await this.app.request(path, { ...init, headers, redirect: "manual" } as any);
    this.absorb(res);
    return res;
  }

  /** Visits the login page to obtain a CSRF cookie and reads the token from the page. */
  async primeCsrf() {
    const res = await this.fetch("/admin/login");
    const html = await res.text();
    const m = /name="csrf-token" content="([^"]+)"/.exec(html);
    this.csrf = m?.[1] ?? null;
    return res;
  }
}

export async function seedAdmin(t: ReturnType<typeof makeTestDeps>, email: string, role: "super_admin" | "admin" = "super_admin", canView = role === "super_admin") {
  return t.repos.allowlist.create({ email, role, can_view_transcripts: canView, invited_by: null });
}

/** Full magic-link login through the real routes. */
export async function login(t: ReturnType<typeof makeTestDeps>, email: string) {
  const client = new Client(t.app);
  await client.primeCsrf();
  const r = await client.fetch("/admin/auth/login", { method: "POST", json: { email } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const link = t.identity.sentLinks.at(-1);
  if (!link || link.email !== email.toLowerCase()) throw new Error("no magic link sent");
  const cb = await client.fetch(`/admin/auth/callback?token_hash=${link.tokenHash}&type=magiclink`);
  if (cb.status !== 302 || cb.headers.get("location") !== "/admin") throw new Error(`callback failed: ${cb.status} ${cb.headers.get("location")}`);
  return client;
}

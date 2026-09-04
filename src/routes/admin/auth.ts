import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { SESSION_COOKIE, decodeSession } from "../../services/adminSession.js";
import { clearSessionCookie, ensureCsrf, writeSessionCookie } from "./middleware.js";
import { csrfMatches } from "../../services/adminSession.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../../services/adminSession.js";

const loginSchema = z.object({ email: z.email().max(254) });

/** Sliding one-hour counter keyed by an arbitrary string (email or IP). */
export class HourlyLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly clock: () => number = Date.now) {}
  allow(key: string): boolean {
    const now = this.clock();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export const LOGIN_RESPONSE = { ok: true, message: "If that address is allowlisted, a sign-in link is on its way. It expires in 15 minutes." };

export function adminAuthRoutes(deps: Deps, getRemoteAddr: (c: any) => string | null = () => null) {
  const app = new Hono();
  const perEmail = new HourlyLimiter(deps.config.magicLinkPerEmailPerHour, () => deps.clock().getTime());
  const perIp = new HourlyLimiter(30, () => deps.clock().getTime());

  app.post("/login", async (c) => {
    if (!csrfMatches(getCookie(c, CSRF_COOKIE), c.req.header(CSRF_HEADER), deps.config.sessionSecret)) {
      return c.json({ error: { code: "forbidden", message: "CSRF token missing or invalid." } }, 403);
    }
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? getRemoteAddr(c) ?? "unknown";
    if (!perIp.allow(ip)) return c.json({ error: { code: "rate_limited", message: "Too many sign-in attempts. Try again later." } }, 429);
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: "invalid_request", message: "Enter a valid email address." } }, 400);
    const email = parsed.data.email.toLowerCase();
    if (!perEmail.allow(email)) return c.json({ error: { code: "rate_limited", message: "Too many sign-in links requested for this address. Try again in an hour." } }, 429);

    const entry = await deps.repos.allowlist.findByEmail(email);
    if (entry && !entry.disabled_at) {
      try {
        if (!entry.auth_user_id) {
          const userId = await deps.identity.ensureUser(email);
          await deps.repos.allowlist.update(entry.id, { auth_user_id: userId });
        }
        await deps.identity.sendMagicLink(email, `${deps.config.publicUrl}/admin/auth/callback`);
        deps.logger.info("magic link requested", { email });
      } catch (err) {
        // Never reveal provider failures to the caller; log for operators.
        deps.logger.error("magic link failed", { email, error: String(err) });
      }
    } else {
      deps.logger.warn("magic link requested for non-allowlisted email", { email_domain: email.split("@")[1] ?? "" });
    }
    return c.json(LOGIN_RESPONSE);
  });

  app.get("/callback", async (c) => {
    const tokenHash = c.req.query("token_hash");
    const providerError = c.req.query("error_description") ?? c.req.query("error");
    if (providerError) return c.redirect(`/admin/login?reason=${encodeURIComponent(providerError)}`);
    if (!tokenHash) return c.redirect("/admin/login?reason=" + encodeURIComponent("Invalid sign-in link."));
    const session = await deps.identity.verifyMagicLink(tokenHash);
    if (!session) return c.redirect("/admin/login?reason=" + encodeURIComponent("This sign-in link is invalid or has expired."));
    const entry = await deps.repos.allowlist.findByEmail(session.email);
    if (!entry || entry.disabled_at) {
      await deps.identity.revokeSessions(session.userId).catch(() => {});
      return c.redirect("/admin/login?reason=" + encodeURIComponent("This account does not have access."));
    }
    const now = deps.clock();
    await deps.repos.allowlist.update(entry.id, { last_login_at: now.toISOString(), auth_user_id: entry.auth_user_id ?? session.userId });
    writeSessionCookie(c, deps, {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      userId: session.userId,
      email: session.email,
      startedAt: Math.floor(now.getTime() / 1000),
    });
    ensureCsrf(c, deps);
    await deps.repos.audit.record({ actor_email: session.email, action: "auth.login", target: null, details: null });
    return c.redirect("/admin");
  });

  app.post("/logout", async (c) => {
    const session = decodeSession(getCookie(c, SESSION_COOKIE), deps.config.sessionSecret);
    if (session && csrfMatches(getCookie(c, CSRF_COOKIE), c.req.header(CSRF_HEADER), deps.config.sessionSecret)) {
      await deps.repos.audit.record({ actor_email: session.email, action: "auth.logout", target: null, details: null });
    }
    clearSessionCookie(c, deps);
    return c.json({ ok: true });
  });

  return app;
}

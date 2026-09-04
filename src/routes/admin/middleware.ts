import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Deps } from "../../deps.js";
import type { AllowlistEntry } from "../../repos/types.js";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_IDLE_SECONDS,
  csrfMatches,
  decodeCsrf,
  decodeSession,
  encodeCsrf,
  encodeSession,
  newCsrfToken,
  sessionExpiredByAge,
  type SessionPayload,
} from "../../services/adminSession.js";

export interface AdminIdentity {
  entry: AllowlistEntry;
  email: string;
  userId: string;
}

export type AdminEnv = { Variables: { admin: AdminIdentity; csrfToken: string } };

const cookieBase = (deps: Deps) => ({
  httpOnly: true,
  secure: deps.config.secureCookies,
  sameSite: "Lax" as const,
  path: "/admin",
});

export function writeSessionCookie(c: Context, deps: Deps, payload: SessionPayload) {
  setCookie(c, SESSION_COOKIE, encodeSession(payload, deps.config.sessionSecret), { ...cookieBase(deps), maxAge: SESSION_IDLE_SECONDS });
}

export function clearSessionCookie(c: Context, deps: Deps) {
  deleteCookie(c, SESSION_COOKIE, { path: "/admin" });
}

/** Ensures a CSRF cookie exists and returns the token to embed in pages. */
export function ensureCsrf(c: Context, deps: Deps): string {
  const existing = decodeCsrf(getCookie(c, CSRF_COOKIE), deps.config.sessionSecret);
  if (existing) return existing;
  const token = newCsrfToken();
  setCookie(c, CSRF_COOKIE, encodeCsrf(token, deps.config.sessionSecret), { ...cookieBase(deps), maxAge: SESSION_IDLE_SECONDS });
  return token;
}

const isApi = (c: Context) => c.req.path.startsWith("/admin/api/");

function reject(c: Context, deps: Deps, reason: string, status: 401 | 403 = 401) {
  if (isApi(c)) return c.json({ error: { code: status === 401 ? "unauthorized" : "forbidden", message: reason } }, status);
  return c.redirect(`/admin/login?reason=${encodeURIComponent(reason)}`);
}

/** Validates the session cookie, refreshes tokens, re-checks the allowlist and enforces CSRF on mutations. */
export function requireAdmin(deps: Deps): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const raw = getCookie(c, SESSION_COOKIE);
    const session = decodeSession(raw, deps.config.sessionSecret);
    if (!session) return reject(c, deps, "Please sign in.");
    const nowSeconds = Math.floor(deps.clock().getTime() / 1000);
    if (sessionExpiredByAge(session, nowSeconds)) {
      clearSessionCookie(c, deps);
      return reject(c, deps, "Session expired. Please sign in again.");
    }

    let payload = session;
    let identity = await deps.identity.verifyAccessToken(session.accessToken);
    if (!identity) {
      const refreshed = await deps.identity.refreshSession(session.refreshToken);
      if (!refreshed) {
        clearSessionCookie(c, deps);
        return reject(c, deps, "Session expired. Please sign in again.");
      }
      payload = { ...session, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
      identity = { userId: refreshed.userId, email: refreshed.email };
    }

    const entry = await deps.repos.allowlist.findByEmail(identity.email);
    if (!entry || entry.disabled_at) {
      clearSessionCookie(c, deps);
      return reject(c, deps, "This account no longer has access.", 403);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const submitted = c.req.header(CSRF_HEADER) ?? (await formCsrf(c));
      if (!csrfMatches(getCookie(c, CSRF_COOKIE), submitted, deps.config.sessionSecret)) {
        return c.json({ error: { code: "forbidden", message: "CSRF token missing or invalid." } }, 403);
      }
    }

    writeSessionCookie(c, deps, payload); // sliding 7-day idle window
    c.set("admin", { entry, email: identity.email, userId: identity.userId });
    c.set("csrfToken", ensureCsrf(c, deps));
    await next();
  };
}

async function formCsrf(c: Context): Promise<string | undefined> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded") && !ct.includes("multipart/form-data")) return undefined;
  try {
    const body = await c.req.parseBody();
    const v = body["_csrf"];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function requireSuperAdmin(): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    if (c.get("admin").entry.role !== "super_admin") {
      return c.json({ error: { code: "forbidden", message: "Super-admin role required." } }, 403);
    }
    await next();
  };
}

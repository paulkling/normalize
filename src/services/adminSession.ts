import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "nrm_admin";
export const CSRF_COOKIE = "nrm_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_IDLE_SECONDS = 7 * 24 * 3600;
export const SESSION_MAX_SECONDS = 30 * 24 * 3600;

export interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  /** Epoch seconds when the session was first created (for the 30-day maximum). */
  startedAt: number;
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** base64url(json).signature */
export function encodeSigned(payload: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function decodeSigned<T>(value: string | undefined, secret: string): T | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

export function encodeSession(p: SessionPayload, secret: string) {
  return encodeSigned(p, secret);
}

export function decodeSession(value: string | undefined, secret: string): SessionPayload | null {
  const p = decodeSigned<SessionPayload>(value, secret);
  if (!p || typeof p.accessToken !== "string" || typeof p.refreshToken !== "string" || typeof p.startedAt !== "number") return null;
  return p;
}

export function sessionExpiredByAge(p: SessionPayload, nowSeconds: number): boolean {
  return nowSeconds - p.startedAt > SESSION_MAX_SECONDS;
}

export function newCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function csrfMatches(cookieValue: string | undefined, submitted: string | undefined, secret: string): boolean {
  const fromCookie = decodeSigned<{ t: string }>(cookieValue, secret)?.t;
  if (!fromCookie || !submitted) return false;
  const a = Buffer.from(fromCookie);
  const b = Buffer.from(submitted);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encodeCsrf(token: string, secret: string) {
  return encodeSigned({ t: token }, secret);
}

export function decodeCsrf(value: string | undefined, secret: string): string | null {
  return decodeSigned<{ t: string }>(value, secret)?.t ?? null;
}

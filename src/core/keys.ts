import { createHash, createHmac, randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const KEY_PREFIX = "nrm_";
export const KEY_RANDOM_LENGTH = 32;
const KEY_RE = /^nrm_[0-9A-Za-z]{32}$/;

export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    // Rejection sampling keeps the distribution uniform over 62 symbols.
    for (const b of randomBytes(length * 2)) {
      if (b < 248) {
        out += BASE62[b % 62];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

export function generateApiKey(): string {
  return KEY_PREFIX + randomBase62(KEY_RANDOM_LENGTH);
}

export function isApiKeyFormat(candidate: string): boolean {
  return KEY_RE.test(candidate);
}

export function keyPrefix(key: string): string {
  return key.slice(0, KEY_PREFIX.length + 4);
}

/** SHA-256 over pepper || key. The key carries ~190 bits of entropy, so a slow hash is unnecessary. */
export function hashApiKey(key: string, pepper: string): string {
  return createHash("sha256").update(pepper).update("\0").update(key).digest("hex");
}

export function hmacIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ip).digest("hex");
}

export function parseBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1]!;
  return isApiKeyFormat(token) ? token : null;
}

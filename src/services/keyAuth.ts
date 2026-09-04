import { ApiError } from "../core/errors.js";
import { hashApiKey, parseBearer } from "../core/keys.js";
import type { ApiKeyRepo } from "../repos/interfaces.js";
import type { ApiKey } from "../repos/types.js";

interface CacheEntry {
  key: ApiKey | null;
  expiresAt: number;
}

export class KeyAuthService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly hashById = new Map<string, string>();

  constructor(
    private readonly repo: ApiKeyRepo,
    private readonly pepper: string,
    private readonly ttlMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Resolves the bearer header to an active key. Throws 401 for unknown/malformed and 403 for revoked. */
  async authenticate(authorization: string | undefined): Promise<ApiKey> {
    const token = parseBearer(authorization);
    if (!token) throw new ApiError("unauthorized");
    const key = await this.lookup(hashApiKey(token, this.pepper));
    if (!key) throw new ApiError("unauthorized");
    if (key.revoked_at) throw new ApiError("forbidden");
    return key;
  }

  private async lookup(hash: string): Promise<ApiKey | null> {
    const now = this.clock();
    const hit = this.cache.get(hash);
    if (hit && hit.expiresAt > now) return hit.key;
    const key = await this.repo.findByHash(hash);
    this.cache.set(hash, { key, expiresAt: now + this.ttlMs });
    if (key) this.hashById.set(key.id, hash);
    return key;
  }

  /** Call after any admin change to a key so revocation/overrides apply immediately. */
  invalidate(keyId: string) {
    const hash = this.hashById.get(keyId);
    if (hash) this.cache.delete(hash);
  }
}

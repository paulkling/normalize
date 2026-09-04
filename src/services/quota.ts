import { ApiError } from "../core/errors.js";
import { currentPeriod, periodResetAt } from "../core/period.js";
import type { QuotaPlanRepo, QuotaUsageRepo, SettingsRepo } from "../repos/interfaces.js";
import type { ApiKey } from "../repos/types.js";

export interface EffectiveLimits {
  monthly: number;
  rps: number;
}

export interface Reservation {
  remaining: number;
  reset_at: string;
  period: string;
}

export class QuotaService {
  private readonly rpsWindows = new Map<string, number[]>();

  constructor(
    private readonly usage: QuotaUsageRepo,
    private readonly plans: QuotaPlanRepo,
    private readonly settings: SettingsRepo,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async limitsFor(key: ApiKey): Promise<EffectiveLimits> {
    const plan = await this.plans.get(key.plan_id);
    const settings = await this.settings.get();
    return {
      monthly: key.monthly_override ?? plan?.monthly_requests ?? 100,
      rps: key.rps_override ?? plan?.rps ?? settings.default_rps,
    };
  }

  /** In-memory 1-second sliding window per key. Throws 429 rate_limited. */
  checkRps(keyId: string, rps: number): void {
    const now = this.clock().getTime();
    const window = (this.rpsWindows.get(keyId) ?? []).filter((t) => now - t < 1000);
    if (window.length >= rps) {
      this.rpsWindows.set(keyId, window);
      throw new ApiError("rate_limited", undefined, {
        retry_after_seconds: 1,
        reset_at: new Date(Math.min(...window) + 1000).toISOString(),
      });
    }
    window.push(now);
    this.rpsWindows.set(keyId, window);
  }

  /** Reserves one request for the current UTC month. Throws 429 quota_exceeded. */
  async reserve(key: ApiKey, monthlyLimit: number): Promise<Reservation> {
    const now = this.clock();
    const period = currentPeriod(now);
    const reset_at = periodResetAt(now);
    const r = await this.usage.reserve(key.id, "", period, monthlyLimit);
    if (!r.ok) throw new ApiError("quota_exceeded", undefined, { reset_at });
    return { remaining: Math.max(0, monthlyLimit + r.topped_up - r.used), reset_at, period };
  }

  async release(key: ApiKey, period: string): Promise<void> {
    await this.usage.release(key.id, "", period);
  }

  async remainingFor(key: ApiKey): Promise<{ used: number; limit: number; remaining: number; reset_at: string }> {
    const now = this.clock();
    const limits = await this.limitsFor(key);
    const row = await this.usage.get(key.id, "", currentPeriod(now));
    const used = row?.used ?? 0;
    const limit = limits.monthly + (row?.topped_up ?? 0);
    return { used, limit, remaining: Math.max(0, limit - used), reset_at: periodResetAt(now) };
  }
}

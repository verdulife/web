import type { Env } from "./types";
import { limitsFromEnv, type LimitsEnvShape } from "./limits";

export interface RateLimit {
  check(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

/**
 * Sliding-window rate limiter backed by an in-process Map of per-key timestamps.
 * Fallback when the native RATE_LIMITER binding is absent.
 */
export class InMemoryRateLimiter implements RateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowSeconds: number,
  ) {}

  async check(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    if (this.hits.size > 1000) this.sweep();

    const now = Date.now();
    const cutoff = now - this.windowSeconds * 1000;
    const fresh = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

    if (fresh.length < this.limit) {
      fresh.push(now);
      this.hits.set(key, fresh);
      if (this.hits.size > 1000) this.sweep();
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.hits.set(key, fresh);
    const oldest = fresh[0] ?? now;
    const elapsedSeconds = Math.max(0, (now - oldest) / 1000);
    const retryAfterSeconds = Math.max(1, Math.ceil(this.windowSeconds - elapsedSeconds));
    return { allowed: false, retryAfterSeconds };
  }

  /** Drop expired entry lists and remove empty keys. Run when the map grows past 1000 keys. */
  private sweep(): void {
    const cutoff = Date.now() - this.windowSeconds * 1000;
    for (const [key, timestamps] of this.hits) {
      const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}

/**
 * Prefers the native Workers rate limiter binding; falls back to the provided
 * limiter when the binding is missing or throws.
 */
export class FallbackRateLimiter implements RateLimit {
  constructor(
    private readonly binding: Env["RATE_LIMITER"] | undefined,
    private readonly fallback: RateLimit,
  ) {}

  async check(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    if (this.binding === undefined) return this.fallback.check(key);
    try {
      const result = await this.binding.limit({ key });
      if (result.success) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: 60 };
    } catch {
      return this.fallback.check(key);
    }
  }
}

export interface RateLimiterEnvShape extends LimitsEnvShape {
  RATE_LIMITER?: Env["RATE_LIMITER"];
}

/** Wires the native binding (when present) with an in-memory sliding-window fallback. */
export function createRateLimiter(env: RateLimiterEnvShape): RateLimit {
  const fallback = new InMemoryRateLimiter(limitsFromEnv(env).rateLimitPerMinute, 60);
  return new FallbackRateLimiter(env.RATE_LIMITER, fallback);
}
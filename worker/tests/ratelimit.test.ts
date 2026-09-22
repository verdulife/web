import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { createRateLimiter, FallbackRateLimiter, InMemoryRateLimiter } from "../src/ratelimit";
import type { RateLimit } from "../src/ratelimit";

function fakeBinding(result: { success: boolean }): Env["RATE_LIMITER"] {
  return { limit: async () => result };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryRateLimiter", () => {
  it("allows a burst under the limit", async () => {
    const limiter = new InMemoryRateLimiter(3, 60);
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await limiter.check("ip-1"));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
  });

  it("denies over the limit with retryAfterSeconds > 0", async () => {
    const limiter = new InMemoryRateLimiter(2, 60);
    await limiter.check("ip-1");
    await limiter.check("ip-1");
    const denied = await limiter.check("ip-1");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // Other keys are unaffected.
    expect((await limiter.check("ip-2")).allowed).toBe(true);
  });

  it("allows again after the window slides (fake timers)", async () => {
    vi.useFakeTimers();
    const limiter = new InMemoryRateLimiter(2, 60);
    await limiter.check("ip-1");
    await limiter.check("ip-1");
    expect((await limiter.check("ip-1")).allowed).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect((await limiter.check("ip-1")).allowed).toBe(true);
  });

  it("counts only timestamps inside the window", async () => {
    vi.useFakeTimers();
    const limiter = new InMemoryRateLimiter(2, 60);
    await limiter.check("ip-1");
    vi.advanceTimersByTime(30_000);
    await limiter.check("ip-1");
    vi.advanceTimersByTime(30_001);
    // Both older hits have slid out; a fresh one is allowed.
    expect((await limiter.check("ip-1")).allowed).toBe(true);
  });
});

describe("FallbackRateLimiter", () => {
  it("allows when the binding reports success", async () => {
    const limiter = new FallbackRateLimiter(fakeBinding({ success: true }), stubFallback());
    expect(await limiter.check("ip-1")).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("denies (60s retry) when the binding reports failure", async () => {
    const limiter = new FallbackRateLimiter(fakeBinding({ success: false }), stubFallback());
    const result = await limiter.check("ip-1");
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("falls back to the in-memory limiter when the binding throws", async () => {
    const throwingBinding: Env["RATE_LIMITER"] = {
      limit: async () => {
        throw new Error("binding unavailable");
      },
    };
    const fallback = stubFallback();
    const limiter = new FallbackRateLimiter(throwingBinding, fallback);
    const result = await limiter.check("ip-1");
    expect(result.allowed).toBe(true);
    expect(fallback.check).toHaveBeenCalledWith("ip-1");
  });

  it("falls back when the binding is missing", async () => {
    const fallback = stubFallback({ allowed: true, retryAfterSeconds: 0 });
    const limiter = new FallbackRateLimiter(undefined, fallback);
    expect(await limiter.check("ip-1")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(fallback.check).toHaveBeenCalledWith("ip-1");
  });
});

describe("createRateLimiter", () => {
  it("wires an in-memory sliding window when no binding is configured", async () => {
    const limiter = createRateLimiter({ RATE_LIMIT_PER_MINUTE: "2" });
    expect(await limiter.check("ip-1")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.check("ip-1")).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("uses the native binding when present", async () => {
    const binding = fakeBinding({ success: true });
    const limiter = createRateLimiter({ RATE_LIMIT_PER_MINUTE: "2", RATE_LIMITER: binding });
    expect((await limiter.check("ip-1")).allowed).toBe(true);
  });
});

function stubFallback(result: { allowed: boolean; retryAfterSeconds: number } = { allowed: true, retryAfterSeconds: 0 }): RateLimit {
  return { check: vi.fn(async () => result) };
}
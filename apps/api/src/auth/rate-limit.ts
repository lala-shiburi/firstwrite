import { AppError } from '../app.js';

export interface RateLimitPolicy {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests allowed within `windowMs` */
  maxRequests: number;
  /** Maximum consecutive failures before temporary lockout */
  lockoutThreshold?: number;
  /** Base lockout duration in milliseconds (doubles on repeated lockouts for backoff) */
  baseLockoutMs?: number;
}

interface BucketState {
  timestamps: number[];
  consecutiveFailures: number;
  lockoutCount: number;
  lockedUntil: number;
}

/**
 * Per-IP and per-account rate limiter with exponential lockout/backoff after repeated failures.
 */
export class AuthRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly nowFn: () => Date;

  constructor(nowFn: () => Date = () => new Date()) {
    this.nowFn = nowFn;
  }

  private getBucket(key: string): BucketState {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        timestamps: [],
        consecutiveFailures: 0,
        lockoutCount: 0,
        lockedUntil: 0,
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Checks whether `key` is currently locked out or over its sliding window rate limit,
   * and records a request hit.
   */
  public consume(key: string, policy: RateLimitPolicy): void {
    const nowMs = this.nowFn().getTime();
    const bucket = this.getBucket(key);

    if (bucket.lockedUntil > nowMs) {
      const retryAfterSec = Math.ceil((bucket.lockedUntil - nowMs) / 1000);
      throw new AppError(
        429,
        'ACCOUNT_LOCKED',
        `Too many failed attempts. Please try again in ${retryAfterSec} seconds.`,
        { retryAfterSeconds: retryAfterSec },
      );
    }

    const windowStart = nowMs - policy.windowMs;
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

    if (bucket.timestamps.length >= policy.maxRequests) {
      const oldest = bucket.timestamps[0] ?? nowMs;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + policy.windowMs - nowMs) / 1000));
      throw new AppError(
        429,
        'RATE_LIMITED',
        `Too many requests. Please try again in ${retryAfterSec} seconds.`,
        { retryAfterSeconds: retryAfterSec },
      );
    }

    bucket.timestamps.push(nowMs);
  }

  /**
   * Records an authentication failure against `key`. If `lockoutThreshold` is reached,
   * applies an exponential backoff lockout (`baseLockoutMs * 2^(lockoutCount - 1)`).
   */
  public recordFailure(key: string, policy: RateLimitPolicy): void {
    const threshold = policy.lockoutThreshold;
    const baseLockoutMs = policy.baseLockoutMs ?? 5 * 60 * 1000;
    if (!threshold) return;

    const nowMs = this.nowFn().getTime();
    const bucket = this.getBucket(key);
    bucket.consecutiveFailures += 1;

    if (bucket.consecutiveFailures >= threshold) {
      bucket.lockoutCount += 1;
      const multiplier = Math.pow(2, bucket.lockoutCount - 1);
      bucket.lockedUntil = nowMs + baseLockoutMs * multiplier;
    }
  }

  /**
   * Resets failure/lockout state for `key` after a successful authentication.
   */
  public recordSuccess(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.consecutiveFailures = 0;
      bucket.lockoutCount = 0;
      bucket.lockedUntil = 0;
    }
  }
}

export const DEFAULT_AUTH_RATE_POLICIES = {
  registerIp: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 10,
  },
  registerAccount: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 5,
  },
  loginIp: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 20,
    lockoutThreshold: 5,
    baseLockoutMs: 5 * 60 * 1000,
  },
  loginAccount: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 10,
    lockoutThreshold: 5,
    baseLockoutMs: 5 * 60 * 1000,
  },
  requestResetIp: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 10,
  },
  requestResetAccount: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 5,
  },
  verifyIp: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 15,
    lockoutThreshold: 5,
    baseLockoutMs: 5 * 60 * 1000,
  },
} satisfies Record<string, RateLimitPolicy>;

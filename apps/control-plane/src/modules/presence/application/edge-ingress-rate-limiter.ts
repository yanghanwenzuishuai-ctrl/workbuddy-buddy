interface Bucket {
  windowStartedAt: number;
  attempts: number;
  touchedAt: number;
}

export interface EdgeIngressRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface EdgeIngressRateLimiter {
  take(ip: string, now?: number): EdgeIngressRateLimitDecision;
}

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_IP_WINDOW = 900;

export function createEdgeIngressRateLimiter(): EdgeIngressRateLimiter {
  const buckets = new Map<string, Bucket>();
  let callsSinceCleanup = 0;

  return {
    take(ip, now = Date.now()) {
      callsSinceCleanup += 1;
      if (callsSinceCleanup >= 512) {
        callsSinceCleanup = 0;
        for (const [key, bucket] of buckets) {
          if (now - bucket.touchedAt > WINDOW_MS * 2) buckets.delete(key);
        }
      }

      const prior = buckets.get(ip);
      const bucket =
        prior === undefined || now - prior.windowStartedAt >= WINDOW_MS
          ? { windowStartedAt: now, attempts: 0, touchedAt: now }
          : prior;
      if (bucket.attempts >= MAX_ATTEMPTS_PER_IP_WINDOW) {
        bucket.touchedAt = now;
        buckets.set(ip, bucket);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (bucket.windowStartedAt + WINDOW_MS - now) / 1_000,
            ),
          ),
        };
      }
      bucket.attempts += 1;
      bucket.touchedAt = now;
      buckets.set(ip, bucket);
      return {
        allowed: true,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(
            (bucket.windowStartedAt + WINDOW_MS - now) / 1_000,
          ),
        ),
      };
    },
  };
}

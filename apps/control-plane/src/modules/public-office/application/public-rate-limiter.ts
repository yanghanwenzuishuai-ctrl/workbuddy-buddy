import { createHash } from "node:crypto";

interface Bucket {
  windowStartedAt: number;
  requests: number;
  activeStreams: number;
  touchedAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface StreamRateLimitDecision extends RateLimitDecision {
  release: () => void;
}

export interface PublicRateLimiter {
  takeSnapshot(ip: string, rawToken: string, now?: number): RateLimitDecision;
  takeStream(
    ip: string,
    rawToken: string,
    now?: number,
  ): StreamRateLimitDecision;
}

const WINDOW_MS = 60_000;
const SNAPSHOT_REQUESTS_PER_IP_WINDOW = 120;
const SNAPSHOT_REQUESTS_PER_TOKEN_WINDOW = 10_000;
const STREAM_OPENS_PER_IP_WINDOW = 20;
const STREAM_OPENS_PER_TOKEN_WINDOW = 2_000;
const STREAMS_PER_IP = 5;
const STREAMS_PER_TOKEN = 1_000;

export function createPublicRateLimiter(): PublicRateLimiter {
  const snapshotBuckets = new Map<string, Bucket>();
  const streamBuckets = new Map<string, Bucket>();
  let callsSinceCleanup = 0;

  const take = (
    buckets: Map<string, Bucket>,
    ip: string,
    rawToken: string,
    limits: {
      ipRequests: number;
      tokenRequests: number;
      ipActive: number | null;
      tokenActive: number | null;
    },
    now: number,
  ): StreamRateLimitDecision => {
    const selected = [
      {
        key: `ip:${ip}`,
        requestLimit: limits.ipRequests,
        activeLimit: limits.ipActive,
      },
      {
        key: `token:${digest(rawToken)}`,
        requestLimit: limits.tokenRequests,
        activeLimit: limits.tokenActive,
      },
    ].map((entry) => ({
      ...entry,
      bucket: currentBucket(buckets.get(entry.key), now),
    }));
    const blocked = selected.find(
      ({ bucket, requestLimit, activeLimit }) =>
        bucket.requests >= requestLimit ||
        (activeLimit !== null && bucket.activeStreams >= activeLimit),
    );
    if (blocked !== undefined) {
      return {
        allowed: false,
        retryAfterSeconds: retryAfter(blocked.bucket, now),
        release: () => undefined,
      };
    }

    for (const { key, bucket, activeLimit } of selected) {
      bucket.requests += 1;
      if (activeLimit !== null) bucket.activeStreams += 1;
      bucket.touchedAt = now;
      buckets.set(key, bucket);
    }
    let released = false;
    return {
      allowed: true,
      retryAfterSeconds: Math.max(
        ...selected.map(({ bucket }) => retryAfter(bucket, now)),
      ),
      release: () => {
        if (released) return;
        released = true;
        for (const { bucket, activeLimit } of selected) {
          if (activeLimit !== null) {
            bucket.activeStreams = Math.max(0, bucket.activeStreams - 1);
          }
        }
      },
    };
  };

  const cleanup = (now: number): void => {
    callsSinceCleanup += 1;
    if (callsSinceCleanup < 256) return;
    callsSinceCleanup = 0;
    for (const buckets of [snapshotBuckets, streamBuckets]) {
      for (const [key, bucket] of buckets) {
        if (
          bucket.activeStreams === 0 &&
          now - bucket.touchedAt > WINDOW_MS * 2
        ) {
          buckets.delete(key);
        }
      }
    }
  };

  return {
    takeSnapshot(ip, rawToken, now = Date.now()) {
      cleanup(now);
      const decision = take(
        snapshotBuckets,
        ip,
        rawToken,
        {
          ipRequests: SNAPSHOT_REQUESTS_PER_IP_WINDOW,
          tokenRequests: SNAPSHOT_REQUESTS_PER_TOKEN_WINDOW,
          ipActive: null,
          tokenActive: null,
        },
        now,
      );
      return {
        allowed: decision.allowed,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    },
    takeStream(ip, rawToken, now = Date.now()) {
      cleanup(now);
      return take(
        streamBuckets,
        ip,
        rawToken,
        {
          ipRequests: STREAM_OPENS_PER_IP_WINDOW,
          tokenRequests: STREAM_OPENS_PER_TOKEN_WINDOW,
          ipActive: STREAMS_PER_IP,
          tokenActive: STREAMS_PER_TOKEN,
        },
        now,
      );
    },
  };
}

function currentBucket(bucket: Bucket | undefined, now: number): Bucket {
  if (bucket === undefined) {
    return {
      windowStartedAt: now,
      requests: 0,
      activeStreams: 0,
      touchedAt: now,
    };
  }
  if (now - bucket.windowStartedAt >= WINDOW_MS) {
    bucket.windowStartedAt = now;
    bucket.requests = 0;
    bucket.touchedAt = now;
  }
  return bucket;
}

function retryAfter(bucket: Bucket, now: number): number {
  return Math.max(
    1,
    Math.ceil((bucket.windowStartedAt + WINDOW_MS - now) / 1_000),
  );
}

function digest(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("base64url");
}

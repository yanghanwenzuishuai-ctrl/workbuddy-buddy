import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";

import type { OfficeRevisionBroker } from "./office-revision-broker.js";
import {
  parsePublicRevisionCursor,
  type PublicOfficeReader,
  type PublicReplayEvent,
} from "./public-office-reader.js";
import type { PublicRateLimiter } from "./public-rate-limiter.js";

const CACHE_CONTROL = "private, no-store";
const STREAM_POLL_INTERVAL_MS = 15_000;
const STREAM_BACKPRESSURE_TIMEOUT_MS = 10_000;

interface PublicOfficeParams {
  public_view_token: string;
}

interface PublicOfficeQuery {
  after_revision?: unknown;
}

type PublicProblemCode =
  | "invalid_request"
  | "public_office_not_found"
  | "revision_gap"
  | "rate_limited"
  | "temporarily_unavailable";

type QueueEventResult = "queued" | "backpressure" | "closed";
type DrainWaitResult = "drained" | "closed" | "timeout";

export interface RegisterPublicOfficeRoutesOptions {
  reader: PublicOfficeReader;
  broker: OfficeRevisionBroker;
  rateLimiter: PublicRateLimiter;
}

export function registerPublicOfficeRoutes(
  app: FastifyInstance,
  options: RegisterPublicOfficeRoutesOptions,
): void {
  app.get<{ Params: PublicOfficeParams }>(
    "/api/v1/offices/:public_view_token/snapshot",
    async (request, reply) => {
      const rawToken = request.params.public_view_token;
      const rate = options.rateLimiter.takeSnapshot(request.ip, rawToken);
      if (!rate.allowed) {
        return sendPublicProblem(reply, "rate_limited", 429, {
          retryAfterSeconds: rate.retryAfterSeconds,
        });
      }
      let snapshot;
      try {
        snapshot = await options.reader.getSnapshot(rawToken);
      } catch {
        return sendPublicProblem(reply, "temporarily_unavailable", 503, {
          retryAfterSeconds: 1,
        });
      }
      if (snapshot === null) {
        return sendPublicProblem(reply, "public_office_not_found", 404);
      }
      reply.header("Cache-Control", CACHE_CONTROL);
      reply.header("ETag", `"office-${snapshot.revision}"`);
      reply.header("X-Office-Revision", String(snapshot.revision));
      return reply
        .status(200)
        .type("application/json; charset=utf-8")
        .send(snapshot.canonicalPayload);
    },
  );

  app.get<{
    Params: PublicOfficeParams;
    Querystring: PublicOfficeQuery;
  }>(
    "/api/v1/offices/:public_view_token/events",
    async (request, reply) => {
      const rawToken = request.params.public_view_token;
      const rate = options.rateLimiter.takeStream(request.ip, rawToken);
      if (!rate.allowed) {
        return sendPublicProblem(reply, "rate_limited", 429, {
          retryAfterSeconds: rate.retryAfterSeconds,
        });
      }

      let disconnected = false;
      let closed = false;
      let streamStarted = false;
      let fallbackTimer: NodeJS.Timeout | undefined;
      let unsubscribe = (): void => undefined;
      const response = reply.raw;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
        unsubscribe();
        rate.release();
      };
      request.raw.once("close", () => {
        disconnected = true;
        cleanup();
      });

      let cursor: number;
      try {
        const headerCursor = parsePublicRevisionCursor(
          request.headers["last-event-id"],
        );
        const queryCursor = parsePublicRevisionCursor(
          request.query.after_revision,
        );
        if (
          headerCursor !== undefined &&
          queryCursor !== undefined &&
          headerCursor !== queryCursor
        ) {
          cleanup();
          return sendPublicProblem(reply, "invalid_request", 400);
        }
        cursor = headerCursor ?? queryCursor ?? 0;
      } catch {
        cleanup();
        return sendPublicProblem(reply, "invalid_request", 400);
      }

      const capability = options.reader.capabilityFor(rawToken);

      let preflight;
      try {
        preflight = await options.reader.getStreamPage(capability, cursor);
      } catch {
        cleanup();
        return sendPublicProblem(reply, "temporarily_unavailable", 503, {
          retryAfterSeconds: 1,
        });
      }
      if (disconnected) return;
      if (preflight.status === "not_found") {
        cleanup();
        return sendPublicProblem(reply, "public_office_not_found", 404);
      }
      if (preflight.status === "revision_gap") {
        cleanup();
        if (preflight.currentRevision === undefined) {
          return sendPublicProblem(reply, "temporarily_unavailable", 503, {
            retryAfterSeconds: 1,
          });
        }
        return sendPublicProblem(reply, "revision_gap", 409, {
          officeRevision: preflight.currentRevision,
        });
      }
      const officeId = preflight.officeId;
      if (
        preflight.currentRevision === undefined ||
        officeId === undefined
      ) {
        cleanup();
        return sendPublicProblem(reply, "temporarily_unavailable", 503, {
          retryAfterSeconds: 1,
        });
      }
      if (cursor > preflight.currentRevision) {
        cleanup();
        return sendPublicProblem(reply, "invalid_request", 400);
      }
      if (
        cursor < preflight.currentRevision &&
        (preflight.events?.[0] === undefined ||
          preflight.events[0].revision !== cursor + 1)
      ) {
        cleanup();
        return sendPublicProblem(reply, "revision_gap", 409, {
          officeRevision: preflight.currentRevision,
        });
      }

      let pumping = false;
      let pendingPump = false;
      let initialReplayComplete = false;
      let lastSent = cursor;
      const close = (): void => {
        cleanup();
        if (streamStarted && !response.writableEnded) response.end();
      };
      const sendResyncAndClose = (): void => {
        if (!closed && streamStarted) {
          response.write(
            "event: resync.required\ndata: {\"reason\":\"revision_gap\"}\n\n",
          );
        }
        close();
      };
      const queueEvent = (event: PublicReplayEvent): QueueEventResult => {
        if (closed) return "closed";
        if (event.revision <= lastSent) return "queued";
        if (event.revision !== lastSent + 1) {
          sendResyncAndClose();
          return "closed";
        }
        if (!canonicalPayloadMatchesRevision(event)) {
          sendResyncAndClose();
          return "closed";
        }
        const frame = Buffer.concat([
          Buffer.from(
            `id: ${event.revision}\nevent: office.snapshot\ndata: `,
            "utf8",
          ),
          event.canonicalPayload,
          Buffer.from("\n\n", "utf8"),
        ]);
        const writable = response.write(frame);
        lastSent = event.revision;
        return writable ? "queued" : "backpressure";
      };
      const pump = async (): Promise<void> => {
        if (closed) return;
        if (pumping) {
          pendingPump = true;
          return;
        }
        pumping = true;
        try {
          do {
            pendingPump = false;
            let drainWait: Promise<DrainWaitResult> | undefined;
            const lease = await options.reader.acquireLockedStreamPage(
              capability,
              lastSent,
            );
            try {
              const page = lease.page;
              if (page.status !== "ok") {
                if (page.status === "revision_gap") sendResyncAndClose();
                else close();
                return;
              }
              for (const event of page.events ?? []) {
                const result = queueEvent(event);
                if (result === "closed") return;
                if (result === "backpressure") {
                  drainWait = waitForDrain(response);
                  break;
                }
              }
              if (
                drainWait === undefined &&
                page.currentRevision !== undefined &&
                lastSent < page.currentRevision
              ) {
                pendingPump = true;
              }
            } finally {
              await lease.release();
            }
            if (drainWait !== undefined) {
              const drainResult = await drainWait;
              if (drainResult !== "drained" || closed) {
                close();
                return;
              }
              pendingPump = true;
            }
          } while (pendingPump && !closed);
        } catch {
          close();
        } finally {
          pumping = false;
          if (pendingPump && !closed) void pump();
        }
      };
      unsubscribe = options.broker.subscribe(officeId, () => {
        pendingPump = true;
        if (streamStarted && initialReplayComplete) void pump();
      });

      let authoritativeLease;
      try {
        authoritativeLease =
          await options.reader.acquireLockedStreamPage(capability, cursor);
      } catch {
        cleanup();
        return sendPublicProblem(reply, "temporarily_unavailable", 503, {
          retryAfterSeconds: 1,
        });
      }
      const authoritative = authoritativeLease.page;
      if (disconnected) {
        await authoritativeLease.release();
        return;
      }
      if (authoritative.status === "not_found") {
        await authoritativeLease.release();
        cleanup();
        return sendPublicProblem(reply, "public_office_not_found", 404);
      }
      if (
        authoritative.status === "revision_gap" ||
        (authoritative.status === "ok" &&
          authoritative.currentRevision !== undefined &&
          cursor < authoritative.currentRevision &&
          (authoritative.events?.[0] === undefined ||
            authoritative.events[0].revision !== cursor + 1))
      ) {
        const currentRevision = authoritative.currentRevision;
        await authoritativeLease.release();
        cleanup();
        if (currentRevision === undefined) {
          return sendPublicProblem(reply, "temporarily_unavailable", 503, {
            retryAfterSeconds: 1,
          });
        }
        return sendPublicProblem(reply, "revision_gap", 409, {
          officeRevision: currentRevision,
        });
      }
      if (
        authoritative.currentRevision === undefined ||
        cursor > authoritative.currentRevision
      ) {
        await authoritativeLease.release();
        cleanup();
        return sendPublicProblem(reply, "invalid_request", 400);
      }

      let initialDrainWait: Promise<DrainWaitResult> | undefined;
      try {
        reply.hijack();
        response.writeHead(200, {
          "Cache-Control": CACHE_CONTROL,
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive",
        });
        response.flushHeaders();
        streamStarted = true;
        response.once("close", cleanup);
        for (const event of authoritative.events ?? []) {
          const result = queueEvent(event);
          if (result === "closed") return;
          if (result === "backpressure") {
            initialDrainWait = waitForDrain(response);
            break;
          }
        }
        if (
          initialDrainWait === undefined &&
          lastSent < authoritative.currentRevision
        ) {
          pendingPump = true;
        }
      } finally {
        await authoritativeLease.release();
      }
      if (initialDrainWait !== undefined) {
        const drainResult = await initialDrainWait;
        if (drainResult !== "drained" || closed) {
          close();
          return;
        }
        pendingPump = true;
      }
      initialReplayComplete = true;
      if (closed) return;

      fallbackTimer = setInterval(() => {
        if (!closed) {
          if (!response.write(": keepalive\n\n")) {
            close();
            return;
          }
          void pump();
        }
      }, STREAM_POLL_INTERVAL_MS);
      fallbackTimer.unref();
      if (pendingPump) await pump();
    },
  );
}

function canonicalPayloadMatchesRevision(event: PublicReplayEvent): boolean {
  try {
    const parsed = JSON.parse(event.canonicalPayload.toString("utf8")) as {
      office_revision?: unknown;
    };
    return parsed.office_revision === event.revision;
  } catch {
    return false;
  }
}

async function waitForDrain(
  response: FastifyReply["raw"],
): Promise<DrainWaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DrainWaitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      response.removeListener("error", onError);
      resolve(result);
    };
    const onDrain = (): void => finish("drained");
    const onClose = (): void => finish("closed");
    const onError = (): void => finish("closed");
    const timer = setTimeout(
      () => finish("timeout"),
      STREAM_BACKPRESSURE_TIMEOUT_MS,
    );
    timer.unref();
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    if (response.destroyed || response.writableEnded) finish("closed");
  });
}

function sendPublicProblem(
  reply: FastifyReply,
  code: PublicProblemCode,
  status: 400 | 404 | 409 | 429 | 503,
  options: {
    officeRevision?: number;
    retryAfterSeconds?: number;
  } = {},
): FastifyReply {
  reply.header("Cache-Control", CACHE_CONTROL);
  if (options.officeRevision !== undefined) {
    reply.header("X-Office-Revision", String(options.officeRevision));
  }
  if (options.retryAfterSeconds !== undefined) {
    reply.header("Retry-After", String(options.retryAfterSeconds));
  }
  return reply
    .status(status)
    .type("application/problem+json")
    .send({
      type: `https://workbuddy-buddy.invalid/problems/${code}`,
      title: publicProblemTitle(code),
      status,
      code,
      ...(options.retryAfterSeconds === undefined
        ? {}
        : { retry_after_seconds: options.retryAfterSeconds }),
    });
}

function publicProblemTitle(code: PublicProblemCode): string {
  switch (code) {
    case "invalid_request":
      return "Invalid request";
    case "public_office_not_found":
      return "Public Office not found";
    case "revision_gap":
      return "Office revision gap";
    case "rate_limited":
      return "Rate limit exceeded";
    case "temporarily_unavailable":
      return "Temporarily unavailable";
  }
}

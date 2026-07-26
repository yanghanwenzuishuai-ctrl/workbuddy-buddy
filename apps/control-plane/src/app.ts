import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  LogController,
} from "fastify";

import type { ControlPlaneConfig } from "./config.js";
import { registerOnboardingPage } from "./onboarding-page.js";
import { registerPublicOfficePage } from "./public-office-page.js";
import { registerOnboardingRoutes } from "./modules/onboarding/application/onboarding-routes.js";
import {
  createOnboardingService,
  type OnboardingService,
} from "./modules/onboarding/application/onboarding-service.js";
import { OnboardingProblem } from "./modules/onboarding/domain/problem.js";
import {
  createNoopOfficeRevisionBroker,
  type OfficeRevisionBroker,
} from "./modules/public-office/application/office-revision-broker.js";
import {
  createPublicOfficeProjector,
  type PublicOfficeProjector,
} from "./modules/public-office/application/public-office-projector.js";
import {
  createPublicOfficeReader,
  type PublicOfficeReader,
} from "./modules/public-office/application/public-office-reader.js";
import { registerPublicOfficeRoutes } from "./modules/public-office/application/public-office-routes.js";
import {
  createPublicRateLimiter,
  type PublicRateLimiter,
} from "./modules/public-office/application/public-rate-limiter.js";
import {
  DisabledEdgeVerifier,
  type EdgeVerifier,
} from "./modules/presence/application/edge-verifier.js";
import {
  createEdgeReportIngestor,
  type EdgeReportIngestor,
} from "./modules/presence/application/ingest-edge-report.js";
import {
  createEdgeReportRateLimiter,
  type EdgeReportRateLimiter,
} from "./modules/presence/application/edge-report-rate-limit.js";
import {
  createEdgeIngressRateLimiter,
  type EdgeIngressRateLimiter,
} from "./modules/presence/application/edge-ingress-rate-limiter.js";
import { ProtocolProblem } from "./modules/presence/domain/problem.js";
import type { EdgeEndpoint } from "./modules/presence/domain/types.js";
import type { EdgeReportValidator } from "./platform/contracts/edge-report-validator.js";
import { migrationStatus } from "./platform/db/migrations.js";
import type { DatabasePool } from "./platform/db/pool.js";

export interface BuildAppOptions {
  config: ControlPlaneConfig;
  pool: DatabasePool;
  validator: EdgeReportValidator;
  verifier?: EdgeVerifier;
  edgeIngressRateLimiter?: EdgeIngressRateLimiter;
  edgeReportRateLimiter?: EdgeReportRateLimiter;
  ingestor?: EdgeReportIngestor;
  publicOfficeProjector?: PublicOfficeProjector;
  publicOfficeReader?: PublicOfficeReader;
  officeRevisionBroker?: OfficeRevisionBroker;
  publicRateLimiter?: PublicRateLimiter;
  onboardingService?: OnboardingService;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.config.maxRequestBytes,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy:
      options.config.trustProxyHops === 0
        ? false
        : options.config.trustProxyHops,
  });
  const verifier = options.verifier ?? new DisabledEdgeVerifier();
  const publicOfficeProjector =
    options.publicOfficeProjector ?? createPublicOfficeProjector();
  const ingestor =
    options.ingestor ??
    createEdgeReportIngestor(
      options.pool,
      options.config.presenceLeaseTtlSeconds,
      publicOfficeProjector,
    );
  const edgeReportRateLimiter =
    options.edgeReportRateLimiter ??
    createEdgeReportRateLimiter(options.pool);
  const edgeIngressRateLimiter =
    options.edgeIngressRateLimiter ??
    createEdgeIngressRateLimiter();

  app.get("/livez", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const status = await migrationStatus(
      options.pool,
      options.config.migrationsDir,
    );
    if (!status.ready) {
      return reply.status(503).send({
        status: "not_ready",
        database: "unavailable_or_migrations_pending",
      });
    }
    return { status: "ok", migration: status.applied };
  });

  registerEdgeRoute(app, "/api/v1/edge/events:batch", "batch");
  registerEdgeRoute(app, "/api/v1/edge/heartbeat", "heartbeat");
  registerOnboardingRoutes(
    app,
    options.onboardingService ??
      createOnboardingService(
        options.pool,
        publicOfficeProjector,
      ),
  );
  registerPublicOfficeRoutes(app, {
    reader: options.publicOfficeReader ?? createPublicOfficeReader(options.pool),
    broker:
      options.officeRevisionBroker ?? createNoopOfficeRevisionBroker(),
    rateLimiter: options.publicRateLimiter ?? createPublicRateLimiter(),
  });
  registerPublicOfficePage(app);
  registerOnboardingPage(app);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OnboardingProblem) {
      reply.header("Cache-Control", "private, no-store");
      if (error.retryAfterSeconds !== undefined) {
        reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      return reply
        .status(error.status)
        .type("application/problem+json")
        .send({
          type: `https://workbuddy-buddy.invalid/problems/${error.code}`,
          title: onboardingProblemTitle(error.code),
          status: error.status,
          code: error.code,
          detail: error.message,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retry_after_seconds: error.retryAfterSeconds }),
        });
    }
    if (error instanceof ProtocolProblem) {
      sendProtocolHeaders(reply);
      if (error.retryAfterSeconds !== undefined) {
        reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      return reply
        .status(error.status)
        .type("application/problem+json")
        .send(error.toBody());
    }
    const fastifyCode = errorCode(error);
    if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      const problem = new ProtocolProblem(
        "payload_too_large",
        413,
        "The encoded report exceeds the configured request limit.",
      );
      sendProtocolHeaders(reply);
      return reply
        .status(problem.status)
        .type("application/problem+json")
        .send(problem.toBody());
    }
    if (
      fastifyCode === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      fastifyCode === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      fastifyCode === "FST_ERR_CTP_INVALID_CONTENT_LENGTH" ||
      fastifyCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
    ) {
      const problem = new ProtocolProblem(
        "invalid_request",
        400,
        "The report body must be valid JSON.",
      );
      sendProtocolHeaders(reply);
      return reply
        .status(problem.status)
        .type("application/problem+json")
        .send(problem.toBody());
    }
    app.log.error({ err: error }, "unhandled control-plane error");
    const problem = new ProtocolProblem(
      "internal_error",
      500,
      "The request could not be completed.",
    );
    sendProtocolHeaders(reply);
    return reply
      .status(problem.status)
      .type("application/problem+json")
      .send(problem.toBody());
  });

  function registerEdgeRoute(
    server: FastifyInstance,
    url: string,
    endpoint: EdgeEndpoint,
  ): void {
    server.post(
      url,
      {
        onRequest: async (request) => {
          const decision = edgeIngressRateLimiter.take(request.ip);
          if (!decision.allowed) {
            throw new ProtocolProblem(
              "rate_limited",
              429,
              "The Edge ingress rate is temporarily limited.",
              undefined,
              decision.retryAfterSeconds,
            );
          }
        },
      },
      async (request, reply) => {
        const report = options.validator.prepare(request.body, endpoint);
        const verified = await verifier.verify(report);
        await edgeReportRateLimiter.consume(
          verified.instanceId,
          report.envelope.events.length,
        );
        const ack = await ingestor.ingest(report, verified);
        sendProtocolHeaders(reply, ack.server_received_at);
        return reply.status(200).send(ack);
      },
    );
  }

  return app;
}

function onboardingProblemTitle(code: OnboardingProblem["code"]): string {
  switch (code) {
    case "invalid_request":
      return "Invalid request";
    case "pairing_not_found":
      return "Pairing not found";
    case "pairing_expired":
      return "Pairing expired";
    case "pairing_conflict":
      return "Pairing conflict";
    case "rate_limited":
      return "Rate limit exceeded";
  }
}

function errorCode(error: unknown): unknown {
  if (error !== null && typeof error === "object" && "code" in error) {
    return error.code;
  }
  return undefined;
}

function sendProtocolHeaders(
  reply: FastifyReply,
  serverReceivedAt?: string,
): void {
  reply.header("X-Protocol-Version", "1");
  reply.header("X-Min-Supported-Protocol", "1");
  reply.header("X-Supported-Protocols", "1");
  if (serverReceivedAt !== undefined) {
    reply.header("X-Server-Received-At", serverReceivedAt);
  }
}

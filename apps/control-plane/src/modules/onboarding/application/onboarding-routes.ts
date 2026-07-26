import type { FastifyInstance, FastifyReply } from "fastify";

import {
  parseClaimPairingInput,
  parseCreateOfficeOnboardingInput,
  parseStatusCapability,
} from "../domain/input.js";
import type { OnboardingService } from "./onboarding-service.js";

const PRIVATE_NO_STORE = "private, no-store";

export function registerOnboardingRoutes(
  app: FastifyInstance,
  service: OnboardingService,
): void {
  app.post<{ Body: unknown }>(
    "/api/v1/onboarding/offices",
    async (request, reply) => {
      const result = await service.createOffice(
        parseCreateOfficeOnboardingInput(request.body),
        request.ip,
      );
      setCapabilityHeaders(reply);
      return reply.status(201).send(result);
    },
  );

  app.get<{ Params: { status_token: string } }>(
    "/api/v1/onboarding/pairings/:status_token",
    async (request, reply) => {
      const result = await service.getPairingStatus(
        parseStatusCapability(request.params.status_token),
        request.ip,
      );
      setCapabilityHeaders(reply);
      return reply.status(200).send(result);
    },
  );

  app.post<{ Body: unknown }>(
    "/api/v1/edge/enrollment/claim",
    async (request, reply) => {
      const result = await service.claim(
        parseClaimPairingInput(request.body),
        request.ip,
      );
      setCapabilityHeaders(reply);
      return reply.status(200).send(result);
    },
  );
}

function setCapabilityHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", PRIVATE_NO_STORE);
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
}

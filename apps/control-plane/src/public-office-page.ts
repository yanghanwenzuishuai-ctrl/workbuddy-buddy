import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply } from "fastify";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);
const PET_PREVIEW_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../frontend/pets",
);
const PUBLIC_PET_IDS = new Set([
  "bloop",
  "buzz-bit",
  "comet-lop",
  "gizmo-kernel",
  "kiki-koala",
  "momo-mug",
  "moss-shell",
  "nimbus-noodle",
  "nori-nibble",
  "olli-orbit",
  "pico-patch",
  "pogo-ping",
  "rumi-relay",
  "sora-shiba",
  "taro-tinker",
]);
const PAGE_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export function registerPublicOfficePage(app: FastifyInstance): void {
  const officeHtml = readFile(path.join(PUBLIC_DIR, "office.html"));
  const officeCss = readFile(path.join(PUBLIC_DIR, "office.css"));
  const officeJs = readFile(path.join(PUBLIC_DIR, "office.js"));

  app.get<{ Params: { public_view_token: string } }>(
    "/o/:public_view_token",
    async (_request, reply) => {
      setPageSecurityHeaders(reply);
      reply.header("Cache-Control", "private, no-store");
      return reply
        .status(200)
        .type("text/html; charset=utf-8")
        .send(await officeHtml);
    },
  );

  app.get("/office.css", async (_request, reply) => {
    setStaticSecurityHeaders(reply);
    return reply
      .status(200)
      .type("text/css; charset=utf-8")
      .send(await officeCss);
  });

  app.get("/office.js", async (_request, reply) => {
    setStaticSecurityHeaders(reply);
    return reply
      .status(200)
      .type("text/javascript; charset=utf-8")
      .send(await officeJs);
  });

  app.get<{ Params: { pet_id: string } }>(
    "/pets/:pet_id/preview.png",
    async (request, reply) => {
      if (!PUBLIC_PET_IDS.has(request.params.pet_id)) {
        reply.header("Cache-Control", "private, no-store");
        return reply.status(404).send();
      }
      setStaticSecurityHeaders(reply);
      return reply
        .status(200)
        .type("image/png")
        .send(
          await readFile(
            path.join(PET_PREVIEW_DIR, request.params.pet_id, "preview.png"),
          ),
        );
    },
  );
}

function setPageSecurityHeaders(reply: FastifyReply): void {
  reply.header("Content-Security-Policy", PAGE_CSP);
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
}

function setStaticSecurityHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "public, max-age=3600");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("X-Content-Type-Options", "nosniff");
}

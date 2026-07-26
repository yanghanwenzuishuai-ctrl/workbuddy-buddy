import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply } from "fastify";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);
const PAGE_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export function registerOnboardingPage(app: FastifyInstance): void {
  const startHtml = readFile(path.join(PUBLIC_DIR, "start.html"));
  const startCss = readFile(path.join(PUBLIC_DIR, "start.css"));
  const startJs = readFile(path.join(PUBLIC_DIR, "start.js"));

  app.get("/start", async (_request, reply) => {
    setPageSecurityHeaders(reply);
    reply.header("Cache-Control", "private, no-store");
    return reply
      .status(200)
      .type("text/html; charset=utf-8")
      .send(await startHtml);
  });

  app.get("/start.css", async (_request, reply) => {
    setStaticSecurityHeaders(reply);
    return reply
      .status(200)
      .type("text/css; charset=utf-8")
      .send(await startCss);
  });

  app.get("/start.js", async (_request, reply) => {
    setStaticSecurityHeaders(reply);
    return reply
      .status(200)
      .type("text/javascript; charset=utf-8")
      .send(await startJs);
  });
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

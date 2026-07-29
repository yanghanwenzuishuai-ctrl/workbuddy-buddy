import type { FastifyInstance, FastifyReply } from "fastify";

const RELEASE_DOWNLOAD_ROOT =
  "https://github.com/FlashFamily/workbuddy-buddy/releases/latest/download";

const MACOS_DOWNLOADS = {
  arm64: `${RELEASE_DOWNLOAD_ROOT}/workbuddy-buddy_macos_arm64.dmg`,
  x64: `${RELEASE_DOWNLOAD_ROOT}/workbuddy-buddy_macos_x64.dmg`,
} as const;

export function registerDesktopDownloadRoutes(app: FastifyInstance): void {
  app.get("/download/macos/arm64", async (_request, reply) => {
    return sendDownloadRedirect(reply, MACOS_DOWNLOADS.arm64);
  });

  app.get("/download/macos/x64", async (_request, reply) => {
    return sendDownloadRedirect(reply, MACOS_DOWNLOADS.x64);
  });
}

function sendDownloadRedirect(
  reply: FastifyReply,
  destination: string,
): FastifyReply {
  reply.header("Cache-Control", "public, max-age=300");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  return reply.redirect(destination, 302);
}

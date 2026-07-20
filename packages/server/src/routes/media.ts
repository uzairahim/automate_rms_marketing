import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authenticateClientRequest } from "../auth/guards.js";
import { createMedia, findMediaById, mediaPublicUrl, type MediaType } from "../media/media.js";
import { deleteMediaFile, mediaFilePath, writeMediaFile } from "../media/storage.js";

/**
 * Media upload and public serve (Slice 9; ADR 0003).
 *
 * Upload requires a Client session; the serve route does not — Meta/TikTok
 * fetch a Media directly by its public URL, never through a Client's session,
 * so it is looked up by id alone rather than scoped to a tenant.
 */

/** "image" or "video" from a Content-Type header, or null if neither. */
function mediaTypeForContentType(contentType: string): MediaType | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return null;
}

/** A filesystem-safe extension derived from the Content-Type's subtype. */
function extensionFor(contentType: string): string {
  const subtype = contentType.split("/")[1]?.split(";")[0] ?? "";
  const cleaned = subtype.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return cleaned || "bin";
}

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  // Upload: stores the file on this server's disk and returns the public
  // HTTPS URL compose references (PRD stories 29-31).
  app.post("/api/media", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const contentType = request.headers["content-type"] ?? "";
    const type = mediaTypeForContentType(contentType);
    const body = request.body;
    if (!type || !Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({
        error: "unsupported_media_type",
        message: "Upload an image/* or video/* file.",
      });
    }

    const { pool, clock, mediaDir, mediaBaseUrl } = app.deps;
    const id = randomUUID();
    const storageKey = `${id}.${extensionFor(contentType)}`;
    await writeMediaFile(mediaDir, storageKey, body);

    try {
      const media = await createMedia(pool, clock, {
        id,
        clientId: ctx.client.id,
        type,
        storageKey,
        contentType,
        byteSize: body.length,
      });
      return reply.code(201).send({
        id: media.id,
        url: mediaPublicUrl(mediaBaseUrl, media.id),
        type: media.type,
      });
    } catch (err) {
      await deleteMediaFile(mediaDir, storageKey);
      throw err;
    }
  });

  // Serve: public and unauthenticated by design — this is the URL the
  // Publisher hands to Meta/TikTok to fetch (ADR 0003).
  app.get<{ Params: { id: string } }>("/api/media/:id", async (request, reply) => {
    const { pool, mediaDir } = app.deps;
    const media = await findMediaById(pool, request.params.id);
    if (!media || media.status !== "active") {
      return reply.code(404).send({ error: "media_not_found" });
    }
    reply.header("content-type", media.contentType);
    return reply.send(createReadStream(mediaFilePath(mediaDir, media.storageKey)));
  });
}

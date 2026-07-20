import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Disk storage for uploaded Media (ADR 0003 — no object store). A thin wrapper
 * over `node:fs`: the app server's local disk *is* the store, so there is no
 * transport to abstract behind an interface, unlike the Publisher seam.
 */

export function mediaFilePath(mediaDir: string, storageKey: string): string {
  return path.join(mediaDir, storageKey);
}

export async function writeMediaFile(
  mediaDir: string,
  storageKey: string,
  data: Buffer,
): Promise<void> {
  await mkdir(mediaDir, { recursive: true });
  await writeFile(mediaFilePath(mediaDir, storageKey), data);
}

/** Idempotent: deleting an already-gone file is not an error. */
export async function deleteMediaFile(mediaDir: string, storageKey: string): Promise<void> {
  try {
    await unlink(mediaFilePath(mediaDir, storageKey));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

import { pathToFileURL } from "node:url";

/**
 * Whether this module is the one Node was asked to run — the guard that lets a
 * file be both an importable module and a CLI entrypoint. Both deployables have
 * such entrypoints (`migrate`, `seed`, `create-superadmin`), so the guard lives
 * here rather than in either of them.
 *
 * Deliberately not the obvious `import.meta.url === \`file://${process.argv[1]}\``:
 * `import.meta.url` is a real URL and percent-encodes what URLs must, while
 * `process.argv[1]` is a plain filesystem path. Any checkout whose path contains
 * a space (or any other character needing encoding) makes those two strings
 * differ, and the entrypoint silently does nothing — a script that appears to run
 * and exits 0 without having done its work. `pathToFileURL` does the same
 * encoding, so the comparison is like-for-like.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href;
}

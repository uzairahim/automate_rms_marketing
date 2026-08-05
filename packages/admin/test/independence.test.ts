import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The admin service is independently deployable (ADR 0010).
 *
 * Its suites import `@smma/server` freely — the consequence previews are counts
 * of that service's Scheduled Posts, and the enforcement they explain happens
 * inside its ticks, so both are only provable with the real thing (PRD #15). That
 * is a **development-only** dependency, and this is the line between the two: a
 * fixture may reach across, shipped code may not.
 *
 * Checked rather than trusted, because the failure is silent and expensive.
 * Nothing about an `import` in `src/` announces that it has just made the
 * suspend-every-Client service undeployable without the internet-facing one; it
 * would surface as a crash in whichever environment the admin panel was first
 * deployed alone to.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");

/** Every `.ts` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("The admin service's independence from the Client-facing one", () => {
  /**
   * Every way one module can name another: `from "…"`, `import("…")`, and
   * `require("…")`, against the package specifier and both spellings of the path
   * across the workspace. Broad about the *specifier* because a pattern that
   * only knew `@smma/server` would wave through the relative path the suites
   * right next door already use — and anchored on the *syntax* so that writing
   * about the boundary, as `src/scheduled-posts.ts` does at length, is not
   * mistaken for crossing it.
   */
  const REACHES_ACROSS =
    /(?:from|import|require)\s*\(?\s*["'][^"']*(?:@smma\/server|\.\.\/server\/|packages\/server\/)/;

  it("has no shipped code that reaches into @smma/server, however it is spelled", () => {
    const offenders = sourceFiles(path.join(packageRoot, "src")).filter((file) =>
      REACHES_ACROSS.test(readFileSync(file, "utf8")),
    );

    expect(offenders.map((file) => path.relative(packageRoot, file))).toEqual([]);
  });

  it("declares no runtime dependency on @smma/server", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    // `dependencies` only. A devDependency on the other workspace package would
    // be a perfectly honest way to express what the fixtures already do by
    // relative path — the line PRD #15 draws is runtime, and this is the list
    // that ships.
    expect(manifest.dependencies?.["@smma/server"]).toBeUndefined();
  });
});

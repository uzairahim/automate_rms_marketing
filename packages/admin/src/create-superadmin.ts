import pg from "pg";
import { isMainModule, ProvisionError, waitForPostgres } from "@smma/core";
import { upsertSuperadmin } from "./auth/superadmins.js";
import { lineReader, type LineReader } from "./prompt.js";

/**
 * `create-superadmin` — how the platform gets its first operator, and how a
 * locked-out one gets back in.
 *
 * There is deliberately no environment-variable bootstrap (ADR 0010). A
 * plaintext password must not live in deploy configuration, and an
 * upsert-on-boot would silently revert a password someone changed later. The
 * password is prompted for and never taken as an argument, so it does not land
 * in shell history — the CLI refuses a second positional argument outright
 * rather than letting one be typed there by mistake.
 *
 * Re-running it for an existing email resets that account's password, which
 * makes it the lockout-recovery path as well as the bootstrap.
 */

/** Where the CLI gets what it must not take from the command line. */
export interface CreateSuperadminPrompts {
  readEmail(): Promise<string>;
  readPassword(): Promise<string>;
}

/**
 * Create or reset the Superadmin account, asking for whatever the operator did
 * not supply. Returns the account and whether it was new.
 *
 * @throws {ProvisionError} `invalid_email` or `weak_password`.
 */
export async function runCreateSuperadmin(
  pool: pg.Pool,
  prompts: CreateSuperadminPrompts,
): Promise<{ id: string; email: string; created: boolean }> {
  const email = await prompts.readEmail();
  const password = await prompts.readPassword();
  return upsertSuperadmin(pool, { email, password });
}

/**
 * Read the command line: an optional email, and nothing else.
 *
 * @throws {Error} if a second argument is present — that would be someone
 * passing the password, which this CLI exists not to accept.
 */
export function createSuperadminArgs(argv: readonly string[]): { email?: string } {
  const [email, ...rest] = argv;
  if (rest.length > 0) {
    throw new Error(
      "Usage: npm run create-superadmin [email]\n" +
        "The password is never taken as an argument — it is prompted for, so it " +
        "does not land in your shell history.",
    );
  }
  return email === undefined ? {} : { email };
}

/** Prompts backed by the terminal: the email echoed, the password never. */
function ttyPrompts(reader: LineReader, email?: string): CreateSuperadminPrompts {
  return {
    readEmail: async () => email ?? (await reader.ask("Superadmin email: ")),
    async readPassword() {
      const password = await reader.ask("Password (not shown): ", true);
      // Asked twice: a typo in a password nobody can see would otherwise lock
      // the operator out of the account they just made.
      const again = await reader.ask("Confirm password: ", true);
      if (password !== again) {
        throw new Error("Passwords did not match.");
      }
      return password;
    },
  };
}

// CLI entrypoint: `npm -w @smma/admin run create-superadmin [email]`.
if (isMainModule(import.meta.url)) {
  const { runAdminMigrations } = await import("./db/migrate.js");
  await import("./load-env.js");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const reader = lineReader();
  try {
    const { email } = createSuperadminArgs(process.argv.slice(2));
    await waitForPostgres(pool);
    // Creating the first operator on a fresh database should not require having
    // run `migrate` first — the migrations are idempotent, so this costs nothing.
    await runAdminMigrations(pool);

    const result = await runCreateSuperadmin(pool, ttyPrompts(reader, email));
    console.log(
      result.created
        ? `Superadmin ${result.email} created.`
        : `Superadmin ${result.email} already existed — password reset, and their ` +
            `live sessions ended.`,
    );
    reader.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(err instanceof ProvisionError ? `${err.code}: ${err.message}` : err);
    reader.close();
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

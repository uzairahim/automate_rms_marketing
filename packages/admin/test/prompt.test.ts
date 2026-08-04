import { PassThrough } from "node:stream";
import { describe, it, expect } from "vitest";
import { lineReader } from "../src/prompt.js";

/**
 * How the CLI asks for a password.
 *
 * A unit suite rather than an API one — there is no HTTP here — but the
 * behaviors are the ones an operator would notice: a password that never
 * appears on screen, and a second prompt that answers rather than hanging when
 * input was piped in all at once.
 */

/** A reader over scripted input, plus everything it printed. */
function reading(input: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let printed = "";
  stdout.on("data", (chunk: Buffer) => {
    printed += chunk.toString();
  });

  const reader = lineReader(stdin, stdout);
  stdin.write(input);
  return { reader, printed: () => printed, endInput: () => stdin.end() };
}

describe("The CLI's prompt", () => {
  it("reads each answer in turn, even when every line arrived at once", async () => {
    // Piped input: both lines are already in the stream before anything is
    // asked. A reader that only listens while asking loses the second one, and
    // hangs at the prompt for it.
    const { reader } = reading("operator@ourapp.test\nhunter hunter hunter\n");

    expect(await reader.ask("Email: ")).toBe("operator@ourapp.test");
    expect(await reader.ask("Password: ", true)).toBe("hunter hunter hunter");

    reader.close();
  });

  it("never prints a secret answer, whether it was typed or piped", async () => {
    const { reader, printed } = reading("hunter hunter hunter\n");

    await reader.ask("Password: ", true);

    expect(printed()).toContain("Password: ");
    expect(printed()).not.toContain("hunter");
    reader.close();
  });

  it("keeps a secret off the screen even before it is asked for", async () => {
    // Everything piped in lands in the stream immediately — including before the
    // first question is written. The echo has to be off by default, not merely
    // switched off once a secret is being asked for.
    const { reader, printed } = reading("hunter hunter hunter\n");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(printed()).not.toContain("hunter");

    await reader.ask("Password: ", true);
    reader.close();
  });

  it("fails rather than hangs when the input ends with a question outstanding", async () => {
    const { reader, endInput } = reading("");

    const answer = reader.ask("Password: ", true);
    endInput();

    await expect(answer).rejects.toThrow(/no input/i);
    reader.close();
  });

  it("trims the answer, so a stray space cannot become part of a password", async () => {
    const { reader } = reading("  operator@ourapp.test  \n");

    expect(await reader.ask("Email: ")).toBe("operator@ourapp.test");
    reader.close();
  });
});

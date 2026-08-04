import { Writable } from "node:stream";
import { createInterface } from "node:readline";

/**
 * Asking an operator questions at a terminal, one of which is a password.
 *
 * Two properties are the whole reason this is not four lines of `readline`:
 *
 * - **A secret is never echoed.** Not while it is typed, and not when input is
 *   piped rather than typed — piped data can arrive and be echoed before
 *   anything has been asked, so the echo is off by default and switched *on*
 *   only for a question whose answer is meant to be visible.
 * - **No line is ever dropped.** Piped input arrives all at once, and a reader
 *   that only listens while it happens to be asking loses the lines that came
 *   early. That failure looks exactly like the CLI hanging at the second prompt,
 *   so lines are queued as they arrive and handed out as they are asked for.
 */
export interface LineReader {
  /** Ask a question and read one line. `secret` keeps the answer off the screen. */
  ask(question: string, secret?: boolean): Promise<string>;
  close(): void;
}

export function lineReader(
  input: NodeJS.ReadableStream = process.stdin,
  echo: NodeJS.WritableStream = process.stdout,
): LineReader {
  let muted = true;
  // Readline echoes keystrokes to its output; gating that write is what keeps a
  // typed password off the screen and out of anyone's scrollback.
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) echo.write(chunk, encoding as BufferEncoding);
      callback();
    },
  });
  const rl = createInterface({ input, output, terminal: true });

  const ready: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  const deliver = (line: string | null) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else if (line !== null) ready.push(line);
  };

  rl.on("line", deliver);
  // Input ended with a question outstanding: fail loudly rather than await forever.
  rl.on("close", () => {
    while (waiting.length) deliver(null);
  });

  return {
    ask(question, secret = false) {
      echo.write(question);
      muted = secret;
      return new Promise((resolve, reject) => {
        const take = (line: string | null) => {
          muted = true;
          // The newline the operator's own Enter would have echoed, so the next
          // prompt does not land on the same line as an invisible answer.
          if (secret) echo.write("\n");
          if (line === null) reject(new Error(`No input received for: ${question.trim()}`));
          // A visible answer is trimmed, because a stray space around a typed
          // email is a slip. A secret is not: trimming it would store a
          // different password than the one the operator typed, and they would
          // then be unable to sign in with what they entered.
          else resolve(secret ? line : line.trim());
        };
        const buffered = ready.shift();
        if (buffered !== undefined) take(buffered);
        else waiting.push(take);
      });
    },
    close: () => rl.close(),
  };
}

import type { EmailMessage, EmailSender } from "./email.js";

/**
 * The email fake for the behavioral test suite. It records every message it is
 * asked to send instead of delivering it, so a test can assert an email was
 * sent and read the reset link out of its body — the "email send faked" seam
 * the password-reset acceptance criteria call for. No real mail is ever sent.
 */
export class FakeEmailSender implements EmailSender {
  /** Every message passed to {@link send}, in call order. */
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push({ ...message });
  }

  /** The most recently sent message, or undefined if none has been sent. */
  last(): EmailMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  /** Messages addressed to a given recipient, in call order. */
  to(recipient: string): EmailMessage[] {
    return this.sent.filter((m) => m.to.toLowerCase() === recipient.toLowerCase());
  }

  /** Forget all recorded messages. */
  reset(): void {
    this.sent.length = 0;
  }
}

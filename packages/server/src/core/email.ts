/**
 * Email-sender interface — the single seam between our domain logic and the
 * transactional-email provider (Resend/Brevo/SES; ADR-free, provider-swappable).
 *
 * All outbound mail goes through this abstraction, so the provider can be
 * changed without touching domain code and, in tests, the real provider is
 * replaced by {@link FakeEmailSender}, which records what *would* be sent — no
 * real email is ever delivered from the behavioral suite. This mirrors the
 * {@link ./publisher.ts Publisher} and {@link ./clock.ts Clock} seams
 * established in Slice 1.
 */

/** A single transactional message. Plain text only for now (the MVP reset mail). */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Production sender backed by Resend's HTTP API. Implemented with `fetch`
 * rather than the SDK so there is no extra dependency or native build step on
 * the small VPS (matching the bcryptjs choice in {@link ../auth/passwords.ts}).
 * The API key is injected from config, never hard-coded.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
    }
  }
}

/**
 * Dev fallback used when no provider key is configured: logs the message (in
 * particular the reset link) to the console instead of delivering it, so the
 * flow is exercisable locally without wiring a real provider.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log(
      `[email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
  }
}

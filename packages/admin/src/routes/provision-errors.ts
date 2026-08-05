import type { FastifyReply } from "fastify";
import { ProvisionError, type ProvisionErrorCode } from "@smma/core";

/**
 * How a provisioning rule broken in `@smma/core` reaches the operator.
 *
 * The core module states the rule and refuses in its own vocabulary; this is the
 * one place that turns that refusal into an HTTP status and a body the panel can
 * render. Keeping the mapping here — rather than at each route — is what stops a
 * later slice from inventing a second status for `subdomain_taken`.
 *
 * The message travels with the code deliberately: every {@link ProvisionError}
 * carries prose written for the person who typed the value, so the panel can
 * show what the platform actually objected to instead of guessing from a code.
 */
const HTTP_STATUS: Record<ProvisionErrorCode, number> = {
  invalid_subdomain: 400,
  invalid_timezone: 400,
  invalid_email: 400,
  weak_password: 400,
  invalid_plan: 400,
  invalid_access_status: 400,
  invalid_app_name: 400,
  invalid_primary_color: 400,
  invalid_logo_url: 400,
  subdomain_taken: 409,
  email_taken: 409,
  client_not_found: 404,
  user_not_found: 404,
};

export function sendProvisionError(reply: FastifyReply, err: ProvisionError): FastifyReply {
  return reply.code(HTTP_STATUS[err.code]).send({ error: err.code, message: err.message });
}

/**
 * Run a handler, answering any {@link ProvisionError} it raises as its mapped
 * status. Anything else is a real fault and is left to Fastify's error handler,
 * which is what keeps a bug from being reported to the operator as a rejected
 * input.
 */
export async function answeringProvisionErrors(
  reply: FastifyReply,
  handle: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await handle();
  } catch (err) {
    if (err instanceof ProvisionError) return sendProvisionError(reply, err);
    throw err;
  }
}

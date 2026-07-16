import { Worker } from "bullmq";
import type pg from "pg";
import type { RedisOptions } from "ioredis";
import type { Clock } from "../core/clock.js";
import type { SecretCipher } from "../core/crypto.js";
import type { Publisher } from "../core/publisher.js";
import { refreshDueTokens } from "../connections/token-refresh.js";
import { purgeExpiredOAuthStates } from "../connections/oauth-state.js";
import {
  TOKEN_REFRESH_QUEUE_NAME,
  type TokenRefreshJobData,
} from "../queue/token-refresh-queue.js";

/**
 * The worker side of the token-refresh tick. Deliberately thin: it is the
 * adapter between BullMQ and {@link refreshDueTokens}, which holds all the
 * behavior and is tested directly. Returns the {@link Worker} so the caller owns
 * its lifecycle.
 */
export function startTokenRefreshWorker(deps: {
  pool: pg.Pool;
  clock: Clock;
  cipher: SecretCipher;
  publisher: Publisher;
  connection: RedisOptions;
}): Worker<TokenRefreshJobData> {
  return new Worker<TokenRefreshJobData>(
    TOKEN_REFRESH_QUEUE_NAME,
    async () => {
      const outcome = await refreshDueTokens(deps.pool, deps.clock, deps.cipher, deps.publisher);
      if (outcome.refreshed || outcome.expired) {
        console.log(
          `[token-refresh] renewed ${outcome.refreshed}, marked ${outcome.expired} token_expired`,
        );
      }

      // Housekeeping on the same tick: an abandoned handshake holds a real user
      // token, so expired ones are dropped rather than left to accumulate. It
      // rides along here because it is the same concern (credentials that have
      // outlived their use) and does not warrant a queue of its own.
      const purged = await purgeExpiredOAuthStates(deps.pool, deps.clock);
      if (purged) console.log(`[token-refresh] purged ${purged} expired OAuth states`);

      return outcome;
    },
    { connection: deps.connection },
  );
}

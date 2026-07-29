import type { Platform, PlatformCredential, PublishRequest } from "../../src/core/publisher.js";

/**
 * A {@link PublishRequest} for the unit tests that drive a Publisher directly.
 *
 * Publishing is always addressed to a destination and authorized by that
 * destination's credential, so both are required on every request. Neither is
 * what these particular tests are about — they exercise recording, scripting,
 * and routing — so this fills them with a fixed stand-in and leaves each test to
 * state only the part it cares about.
 */
export const TEST_CREDENTIAL: PlatformCredential = {
  accessToken: "test-page-token",
  refreshable: true,
};

export function publishRequest(
  platform: Platform,
  overrides: Partial<PublishRequest> = {},
): PublishRequest {
  return {
    platform,
    text: "",
    credential: TEST_CREDENTIAL,
    externalId: `${platform}-destination`,
    ...overrides,
  };
}

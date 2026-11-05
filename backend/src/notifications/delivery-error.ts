/** What a provider returns once it has accepted a message. The reference is the provider's own id, for tracing it in their dashboard. */
export interface SendResult {
  reference?: string;
}

/**
 * A delivery that did not happen. `retryable` is the provider-independent answer to "is trying again worthwhile?": a timeout, a
 * rate limit or a provider outage is; a refused sender, an invalid recipient or a bad credential is not (retrying only repeats
 * the refusal, so the message is kept as FAILED for a person to look at). The message never contains a credential.
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The provider's own error code or name, e.g. Resend's "validation_error" or Twilio's 21211. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** HTTP statuses worth retrying: the request timed out, was rate limited, or the provider failed. Anything else is a refusal. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** An error that is not a DeliveryError (a bug, a dropped connection) is treated as retryable: giving up is the riskier guess. */
export function isRetryable(error: unknown): boolean {
  return error instanceof DeliveryError ? error.retryable : true;
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compares two hex digests in constant time. Anything malformed (wrong length, not a string) is simply "not equal". */
function sameDigest(expectedHex: string, givenHex: unknown): boolean {
  if (typeof givenHex !== 'string' || !/^[0-9a-f]+$/i.test(givenHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(givenHex, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Checks the signature Razorpay Checkout hands the browser after a payment: HMAC-SHA256 of "order_id|payment_id" with the
 * API key SECRET. Only someone holding the secret can produce a valid one, so a forged "payment succeeded" is rejected.
 */
export function checkoutSignatureValid(orderId: string, paymentId: string, signature: unknown, keySecret: string): boolean {
  if (!keySecret) return false;
  return sameDigest(createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex'), signature);
}

/**
 * Checks the X-Razorpay-Signature header of a webhook: HMAC-SHA256 of the EXACT raw request body with the webhook secret.
 * It must be the raw bytes as received; a re-serialised copy of the parsed JSON would not match.
 */
export function webhookSignatureValid(rawBody: Buffer | string | undefined, signature: unknown, webhookSecret: string): boolean {
  if (!webhookSecret || rawBody === undefined) return false;
  return sameDigest(createHmac('sha256', webhookSecret).update(rawBody).digest('hex'), signature);
}

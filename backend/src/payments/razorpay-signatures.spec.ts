import { createHmac } from 'node:crypto';
import { checkoutSignatureValid, webhookSignatureValid } from './razorpay-signatures.js';

const hmac = (secret: string, text: string | Buffer) => createHmac('sha256', secret).update(text).digest('hex');

describe('checkoutSignatureValid', () => {
  const secret = 'key_secret';

  it('accepts the signature Razorpay produces for "order_id|payment_id"', () => {
    expect(checkoutSignatureValid('order_1', 'pay_1', hmac(secret, 'order_1|pay_1'), secret)).toBe(true);
  });

  it('rejects a signature for a different order, a different payment, or a different secret', () => {
    const good = hmac(secret, 'order_1|pay_1');
    expect(checkoutSignatureValid('order_2', 'pay_1', good, secret)).toBe(false);
    expect(checkoutSignatureValid('order_1', 'pay_2', good, secret)).toBe(false);
    expect(checkoutSignatureValid('order_1', 'pay_1', good, 'other_secret')).toBe(false);
  });

  it('rejects anything that is not a full hex digest, without throwing', () => {
    for (const bad of ['', 'abc', 'zz'.repeat(32), undefined, null, 42, {}, hmac(secret, 'order_1|pay_1').slice(2)]) {
      expect(checkoutSignatureValid('order_1', 'pay_1', bad, secret)).toBe(false);
    }
  });

  it('never accepts anything when no secret is configured', () => {
    expect(checkoutSignatureValid('order_1', 'pay_1', hmac('', 'order_1|pay_1'), '')).toBe(false);
  });

  it('requires the "|" between the ids, as Razorpay signs it', () => {
    expect(checkoutSignatureValid('order_1', 'pay_1', hmac(secret, 'order_1pay_1'), secret)).toBe(false);
    expect(checkoutSignatureValid('order_1', 'pay_1', hmac(secret, 'pay_1|order_1'), secret)).toBe(false);
  });
});

describe('webhookSignatureValid', () => {
  const secret = 'webhook_secret';
  const body = '{"event":"payment.captured"}';

  it('accepts the signature over the exact raw body, as text or bytes', () => {
    expect(webhookSignatureValid(body, hmac(secret, body), secret)).toBe(true);
    expect(webhookSignatureValid(Buffer.from(body), hmac(secret, body), secret)).toBe(true);
  });

  it('rejects a body that changed by even one character or a bit of whitespace', () => {
    const signature = hmac(secret, body);
    expect(webhookSignatureValid(body.replace('captured', 'failed_'), signature, secret)).toBe(false);
    expect(webhookSignatureValid(`${body} `, signature, secret)).toBe(false);
  });

  it('rejects a missing body, a missing or wrong signature, and a missing secret', () => {
    expect(webhookSignatureValid(undefined, hmac(secret, body), secret)).toBe(false);
    expect(webhookSignatureValid(body, undefined, secret)).toBe(false);
    expect(webhookSignatureValid(body, hmac('wrong', body), secret)).toBe(false);
    expect(webhookSignatureValid(body, hmac('', body), '')).toBe(false);
  });
});

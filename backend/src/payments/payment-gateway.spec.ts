import { DisabledPaymentGateway, GatewayError, RazorpayGateway, createPaymentGateway, isValidIdempotencyKey } from './payment-gateway.js';

const config = { keyId: 'rzp_test_abc', keySecret: 'super_secret_value' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in that records the call and answers with the given status and JSON. */
function fakeFetch(status: number, json: unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('RazorpayGateway', () => {
  it('creates an order in paise with HTTP Basic auth, and never sends the secret in the body', async () => {
    const { impl, calls } = fakeFetch(200, { id: 'order_1', amount: 65000, currency: 'INR' });
    const order = await new RazorpayGateway(config, impl).createOrder({ amountPaise: 65000, receipt: 'a'.repeat(60), notes: { appointmentId: 'x' } });
    expect(order).toEqual({ id: 'order_1', amountPaise: 65000, currency: 'INR' });
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('rzp_test_abc:super_secret_value').toString('base64')}`);
    expect(calls[0].body).toMatchObject({ amount: 65000, currency: 'INR', notes: { appointmentId: 'x' } });
    expect((calls[0].body as { receipt: string }).receipt).toHaveLength(40); // Razorpay's limit
    expect(JSON.stringify(calls[0].body)).not.toContain('super_secret_value');
  });

  it('sends a refund with an idempotency header so a retry cannot refund twice', async () => {
    const { impl, calls } = fakeFetch(200, { id: 'rfnd_1', status: 'processed', amount: 32500 });
    const refund = await new RazorpayGateway(config, impl).createRefund({ paymentId: 'pay_1', amountPaise: 32500, idempotencyKey: 'rfnd-0f8fad5b-d9cb', notes: { refundId: 'abc' } });
    expect(refund).toEqual({ id: 'rfnd_1', status: 'processed', amountPaise: 32500 });
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund');
    expect(calls[0].headers['X-Refund-Idempotency']).toBe('rfnd-0f8fad5b-d9cb');
    expect(calls[0].body).toEqual({ amount: 32500, speed: 'normal', notes: { refundId: 'abc' } });
  });

  it('sends the very same request every time it is repeated, so Razorpay recognises a retry', async () => {
    const { impl, calls } = fakeFetch(200, { id: 'rfnd_1', status: 'pending', amount: 32500 });
    const gateway = new RazorpayGateway(config, impl);
    const input = { paymentId: 'pay_1', amountPaise: 32500, idempotencyKey: 'rfnd-0f8fad5b-d9cb', notes: { refundId: 'abc' } };
    await gateway.createRefund(input);
    await gateway.createRefund(input);
    expect(calls[1]).toEqual(calls[0]);
  });

  it('refuses, before sending anything, a key Razorpay would reject, so it is never mistaken for Razorpay refusing the refund', async () => {
    const { impl, calls } = fakeFetch(200, { id: 'rfnd_1', status: 'pending', amount: 1 });
    for (const idempotencyKey of ['cancel:abc-def-ghij', 'short', 'has space in it', 'accent-é-in-key-12']) {
      await expect(new RazorpayGateway(config, impl).createRefund({ paymentId: 'pay_1', amountPaise: 1, idempotencyKey, notes: {} })).rejects.toThrow(/idempotency key/);
    }
    expect(calls).toHaveLength(0);
  });

  it('finds a refund by our note, even when other refunds have empty notes (which Razorpay returns as an array)', async () => {
    const { impl, calls } = fakeFetch(200, {
      items: [
        { id: 'rfnd_dashboard', status: 'processed', amount: 100, notes: [] },
        { id: 'rfnd_other', status: 'pending', amount: 200, notes: { refundId: 'someone-else' } },
        { id: 'rfnd_ours', status: 'pending', amount: 300, notes: { refundId: 'abc' } },
      ],
    });
    const found = await new RazorpayGateway(config, impl).findRefundByNote('pay_1', 'abc');
    expect(found).toEqual({ id: 'rfnd_ours', status: 'pending', amountPaise: 300 });
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payments/pay_1/refunds?count=100');
    expect(await new RazorpayGateway(config, fakeFetch(200, { items: [] }).impl).findRefundByNote('pay_1', 'abc')).toBeNull();
    expect(await new RazorpayGateway(config, fakeFetch(200, {}).impl).findRefundByNote('pay_1', 'abc')).toBeNull();
  });

  it('reports anything other than processed or failed as pending, so it is never mistaken for completed', async () => {
    for (const status of ['pending', 'created', 'something_new']) {
      const { impl } = fakeFetch(200, { id: 'rfnd_1', status, amount: 1 });
      expect((await new RazorpayGateway(config, impl).fetchRefund('rfnd_1')).status).toBe('pending');
    }
    const { impl } = fakeFetch(200, { id: 'rfnd_1', status: 'failed', amount: 1 });
    expect((await new RazorpayGateway(config, impl).fetchRefund('rfnd_1')).status).toBe('failed');
  });

  it('turns a Razorpay error into a GatewayError with its status and description, and never echoes credentials', async () => {
    const { impl } = fakeFetch(400, { error: { description: 'The amount must be at least INR 1.00' } });
    const error = await new RazorpayGateway(config, impl).createOrder({ amountPaise: 1, receipt: 'r', notes: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).status).toBe(400);
    expect((error as GatewayError).message).toBe('The amount must be at least INR 1.00');
    expect((error as GatewayError).message).not.toContain('super_secret_value');
  });

  it('reports an unreachable Razorpay as a GatewayError without a status (so it is retried, not treated as final)', async () => {
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const error = await new RazorpayGateway(config, down).fetchRefund('rfnd_1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).status).toBeUndefined();
  });

  it('exposes only the public key id', () => {
    expect(new RazorpayGateway(config).keyId).toBe('rzp_test_abc');
  });
});

describe('createPaymentGateway', () => {
  const base = { webhookSecret: '', holdMinutes: 15, refundPolicy: { fullRefundHoursBefore: 24, partialRefundHoursBefore: 2, partialRefundPercent: 50 } };

  it('is off without keys, and refuses to create anything', async () => {
    const gateway = createPaymentGateway({ ...base, enabled: false, keyId: '', keySecret: '' });
    expect(gateway).toBeInstanceOf(DisabledPaymentGateway);
    expect(gateway.enabled).toBe(false);
    await expect(gateway.createOrder({ amountPaise: 100, receipt: 'r', notes: {} })).rejects.toBeInstanceOf(GatewayError);
  });

  it('is Razorpay when keys are configured', () => {
    const gateway = createPaymentGateway({ ...base, enabled: true, ...config });
    expect(gateway).toBeInstanceOf(RazorpayGateway);
    expect(gateway.enabled).toBe(true);
  });
});

describe('isValidIdempotencyKey', () => {
  it("follows Razorpay's rule: 10 or more letters, digits, hyphens or underscores", () => {
    for (const ok of ['rfnd-550e8400-e29b-41d4-a716-446655440000', 'abcdefghij', 'A_b-1_2-3_4']) expect(isValidIdempotencyKey(ok)).toBe(true);
    for (const bad of ['', 'abcdefghi', 'cancel:550e8400', 'a b c d e f g h', 'key.with.dots.12', 'ключ-ключ-ключ']) expect(isValidIdempotencyKey(bad)).toBe(false);
  });
});

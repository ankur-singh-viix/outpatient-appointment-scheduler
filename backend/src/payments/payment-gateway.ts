import type { PaymentsConfig } from '../config.js';

export interface GatewayOrder {
  id: string;
  amountPaise: number;
  currency: string;
}

/** `pending`: Razorpay accepted the refund and is still processing it. Only `processed` means it is confirmed. */
export interface GatewayRefund {
  id: string;
  status: 'pending' | 'processed' | 'failed';
  amountPaise: number;
}

/** What the rest of the backend needs from a payment provider. Swapped for a fake in tests so no network or keys are needed. */
export interface PaymentGateway {
  readonly enabled: boolean;
  /** The public key id the browser needs to open Checkout. Never the secret. */
  readonly keyId: string;
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  /**
   * `idempotencyKey` makes a retry of the same refund safe: Razorpay answers a repeat with the first refund instead of making a
   * second, but only if the key is valid (see `isValidIdempotencyKey`) and the request is IDENTICAL to the first.
   */
  createRefund(input: { paymentId: string; amountPaise: number; idempotencyKey: string; notes: Record<string, string> }): Promise<GatewayRefund>;
  fetchRefund(refundId: string): Promise<GatewayRefund>;
  /**
   * Looks for a refund on this payment that carries our `refundId` note. Used before re-sending a refund whose earlier attempt
   * ended in an unknown state (the request may have reached Razorpay even though no answer came back), so a lost answer can
   * never turn into a second refund, whatever the provider's idempotency window.
   */
  findRefundByNote(paymentId: string, refundId: string): Promise<GatewayRefund | null>;
}

/** Razorpay's rule for X-Refund-Idempotency: at least 10 characters, only letters, digits, hyphens and underscores. */
export function isValidIdempotencyKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{10,}$/.test(key);
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** The provider could not be reached or refused the request. The message is safe to show; it never contains credentials. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const API = 'https://api.razorpay.com/v1';

interface RazorpayRefundBody {
  id: string;
  status: string;
  amount: number;
}

function toRefund(body: RazorpayRefundBody): GatewayRefund {
  return { id: body.id, status: body.status === 'processed' ? 'processed' : body.status === 'failed' ? 'failed' : 'pending', amountPaise: body.amount };
}

/** Razorpay over its HTTPS API (https://razorpay.com/docs/api). Test mode or live mode is decided by the key itself. */
export class RazorpayGateway implements PaymentGateway {
  readonly enabled = true;

  constructor(
    private readonly config: Pick<PaymentsConfig, 'keyId' | 'keySecret'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get keyId(): string {
    return this.config.keyId;
  }

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder> {
    const body = await this.call<{ id: string; amount: number; currency: string }>('POST', '/orders', {
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    return { id: body.id, amountPaise: body.amount, currency: body.currency };
  }

  async createRefund(input: { paymentId: string; amountPaise: number; idempotencyKey: string; notes: Record<string, string> }): Promise<GatewayRefund> {
    // Razorpay would answer a bad key with HTTP 400. Refuse here instead, so it is never mistaken for Razorpay refusing the refund.
    if (!isValidIdempotencyKey(input.idempotencyKey)) throw new Error('Internal error: invalid refund idempotency key.');
    const body = await this.call<RazorpayRefundBody>(
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      { amount: input.amountPaise, speed: 'normal', notes: input.notes },
      { 'X-Refund-Idempotency': input.idempotencyKey },
    );
    return toRefund(body);
  }

  async fetchRefund(refundId: string): Promise<GatewayRefund> {
    return toRefund(await this.call<RazorpayRefundBody>('GET', `/refunds/${encodeURIComponent(refundId)}`));
  }

  async findRefundByNote(paymentId: string, refundId: string): Promise<GatewayRefund | null> {
    const page = await this.call<{ items?: (RazorpayRefundBody & { notes?: unknown })[] }>('GET', `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`);
    // `notes` is an empty ARRAY when a refund has none, so check the shape before reading it.
    const match = (page.items ?? []).find((item) => {
      const notes = item.notes;
      return typeof notes === 'object' && notes !== null && !Array.isArray(notes) && (notes as Record<string, unknown>).refundId === refundId;
    });
    return match ? toRefund(match) : null;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object, extraHeaders: Record<string, string> = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64')}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GatewayError('Could not reach Razorpay.');
    }
    const data = (await response.json().catch(() => null)) as (T & { error?: { description?: string } }) | null;
    if (!response.ok || !data) {
      // Razorpay's own error text ("The amount must be at least 100") is safe to surface; no credential is ever echoed in it.
      throw new GatewayError(data?.error?.description ?? `Razorpay responded with HTTP ${response.status}.`, response.status);
    }
    return data;
  }
}

/** Used when no Razorpay keys are configured: booking stays free and no payment endpoint can create anything. */
export class DisabledPaymentGateway implements PaymentGateway {
  readonly enabled = false;
  readonly keyId = '';
  async createOrder(): Promise<GatewayOrder> {
    throw new GatewayError('Payments are not configured.');
  }
  async createRefund(): Promise<GatewayRefund> {
    throw new GatewayError('Payments are not configured.');
  }
  async fetchRefund(): Promise<GatewayRefund> {
    throw new GatewayError('Payments are not configured.');
  }
  async findRefundByNote(): Promise<GatewayRefund | null> {
    throw new GatewayError('Payments are not configured.');
  }
}

export function createPaymentGateway(config: PaymentsConfig): PaymentGateway {
  return config.enabled ? new RazorpayGateway(config) : new DisabledPaymentGateway();
}

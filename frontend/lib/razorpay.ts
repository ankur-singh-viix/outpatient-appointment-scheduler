import type { CheckoutDetails } from './types';

/** The few parts of Razorpay Checkout we use (https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/). */
interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string };
  theme?: { color: string };
  handler: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => void;
  modal: { ondismiss: () => void };
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', callback: (response: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
let loading: Promise<void> | null = null;

/** Loads Razorpay's own script once, only when someone is about to pay. It is never bundled or loaded on other pages. */
export function loadRazorpay(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Payments need a browser.'));
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null; // allow another try (an ad blocker or a flaky connection)
      script.remove();
      reject(new Error('Could not load the payment window. Check your connection or ad blocker and try again.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export type CheckoutResult =
  | { outcome: 'paid'; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }
  | { outcome: 'dismissed' };

/**
 * Opens Razorpay Checkout for an order the BACKEND created. Resolves when the person pays (with the three values the server
 * must verify) or closes the window. A failed attempt does not end it: Razorpay lets the person retry inside the window, and
 * `onFailure` is told so the page can show the reason.
 */
export async function openRazorpayCheckout(
  details: CheckoutDetails,
  prefill: { name: string; email: string },
  onFailure: (message: string) => void,
): Promise<CheckoutResult> {
  await loadRazorpay();
  return new Promise<CheckoutResult>((resolve) => {
    const Razorpay = window.Razorpay!;
    const checkout = new Razorpay({
      key: details.keyId,
      amount: details.amountPaise,
      currency: details.currency,
      order_id: details.orderId,
      name: 'CareSlot',
      description: 'Consultation fee',
      prefill,
      theme: { color: '#00796b' },
      handler: (response) =>
        resolve({
          outcome: 'paid',
          razorpayOrderId: response.razorpay_order_id,
          razorpayPaymentId: response.razorpay_payment_id,
          razorpaySignature: response.razorpay_signature,
        }),
      modal: { ondismiss: () => resolve({ outcome: 'dismissed' }) },
    });
    checkout.on('payment.failed', (response) => onFailure(response.error?.description ?? 'The payment did not go through. You can try again.'));
    checkout.open();
  });
}

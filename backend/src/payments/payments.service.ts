import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { zonedInstant } from '../common/zoned-time.js';
import { loadConfig } from '../config.js';
import { Appointment, Patient, Payment, PaymentEvent, Refund } from '../database/entities/index.js';
import { isUniqueViolation } from '../database/errors.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { hhmm } from '../scheduling/slots.js';
import { GatewayError, PAYMENT_GATEWAY, type GatewayRefund, type PaymentGateway } from './payment-gateway.js';
import { toPaymentSummary, type PaymentSummary } from './payment-summary.js';
import { refundFor, type CancelledBy, type RefundDecision } from './refund-policy.js';
import { checkoutSignatureValid, webhookSignatureValid } from './razorpay-signatures.js';

/** What the browser needs to open Razorpay Checkout for a booking. Never contains the secret key. */
export interface CheckoutDetails {
  appointmentId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  keyId: string;
  /** When the held slot is released if payment has not completed. */
  expiresAt: Date | null;
}

/** What a cancellation decided about money, for the caller to put in its email and to act on after its commit. */
export interface CancellationOutcome {
  refundNote?: string;
  /** Refund ids to send to Razorpay once the cancelling transaction has committed. */
  afterCommit: string[];
}

export interface VerifyInput {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

interface WebhookEvent {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; amount?: number; currency?: string; error_description?: string } };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number; status?: string } };
  };
}

const HOLD_CANCEL_REASON = 'Payment was not completed in time, so the slot was released.';
/** An abusive or careless patient could otherwise lock up many slots at once without paying. */
const MAX_UNPAID_HOLDS = 3;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');
  private readonly config = loadConfig();

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Patient) private readonly patients: Repository<Patient>,
    private readonly dataSource: DataSource,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly notifications: NotificationsService,
  ) {}

  /** Whether bookings with a fee must be paid for. Off without Razorpay keys, which keeps booking exactly as it was. */
  get enabled(): boolean {
    return this.gateway.enabled;
  }

  get holdMinutes(): number {
    return this.config.payments.holdMinutes;
  }

  /** Public, non-secret settings the booking screen needs: whether payment is on, how long a hold lasts, the refund rules. */
  publicConfig() {
    const { holdMinutes, refundPolicy } = this.config.payments;
    return { enabled: this.enabled, holdMinutes, refundPolicy };
  }

  // ---------------------------------------------------------------- Booking

  /** Frees this doctor's slots whose unpaid hold has run out. Call inside a transaction that already holds the doctor's row lock. */
  async releaseLapsedHolds(manager: EntityManager, doctorId: string, now = new Date()): Promise<void> {
    const lapsed = await manager.find(Appointment, {
      select: { id: true },
      where: { doctorId, status: 'PENDING', holdExpiresAt: LessThanOrEqual(now) },
    });
    for (const { id } of lapsed) await this.cancelHold(manager, id, HOLD_CANCEL_REASON, now);
  }

  /** Called while booking, inside the doctor-locked transaction: frees lapsed holds, and caps how many unpaid holds one patient keeps. */
  async prepareForBooking(manager: EntityManager, doctorId: string, patientId: string, now = new Date()): Promise<void> {
    await this.releaseLapsedHolds(manager, doctorId, now);

    const unpaid = await manager.count(Appointment, { where: { patientId, status: 'PENDING', holdExpiresAt: Not(IsNull()) } });
    if (unpaid >= MAX_UNPAID_HOLDS) {
      throw new ConflictException('You have bookings waiting for payment. Finish paying for them, or cancel them, before booking another.');
    }
  }

  /**
   * Starts payment for a held appointment. The amount is the doctor's fee from the database, converted to paise: nothing the
   * browser sends can change it. If Razorpay cannot be reached the hold is released straight away.
   */
  async createCheckout(appointmentId: string): Promise<CheckoutDetails> {
    const appointment = await this.dataSource.getRepository(Appointment).findOneOrFail({ where: { id: appointmentId }, relations: { doctor: true } });
    const amountPaise = appointment.doctor.consultationFee * 100;
    let order;
    try {
      order = await this.gateway.createOrder({ amountPaise, receipt: appointment.id, notes: { appointmentId: appointment.id, patientId: appointment.patientId } });
    } catch (error) {
      this.logger.warn(`Could not create a Razorpay order: ${(error as Error).message}`);
      await this.dataSource.transaction((manager) => this.cancelHold(manager, appointment.id, 'Payment could not be started.', null));
      throw new ServiceUnavailableException('We could not start the payment. Please try again in a moment.');
    }
    try {
      await this.payments.save(
        this.payments.create({ appointmentId: appointment.id, patientId: appointment.patientId, razorpayOrderId: order.id, amountPaise, currency: order.currency }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two requests raced: the other one's order is the live one, so use that and ignore ours.
    }
    return this.checkoutDetails(appointment.id);
  }

  /** Lets a patient reopen Checkout for a booking that is still waiting for payment (closed the window, payment failed, page reloaded). */
  async resumeCheckout(user: AuthUser, appointmentId: string): Promise<CheckoutDetails> {
    const patientId = await this.patientIdFor(user.id);
    const appointment = await this.dataSource.getRepository(Appointment).findOneBy({ id: appointmentId, patientId });
    if (!appointment) throw new NotFoundException('Appointment not found.');
    if (appointment.status !== 'PENDING') throw new ConflictException('This booking is not waiting for payment.');
    if (appointment.holdExpiresAt && appointment.holdExpiresAt.getTime() <= Date.now()) {
      await this.dataSource.transaction((manager) => this.cancelHold(manager, appointment.id, HOLD_CANCEL_REASON, new Date()));
      throw new ConflictException('This booking expired because payment was not completed in time. Please choose a slot again.');
    }
    return this.checkoutDetails(appointment.id);
  }

  private async checkoutDetails(appointmentId: string): Promise<CheckoutDetails> {
    const payment = await this.payments.findOne({ where: { appointmentId, status: In(['CREATED', 'FAILED']) }, relations: { appointment: true } });
    if (!payment) throw new ConflictException('There is no payment to complete for this booking.');
    return {
      appointmentId,
      orderId: payment.razorpayOrderId,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      keyId: this.gateway.keyId,
      expiresAt: payment.appointment.holdExpiresAt,
    };
  }

  /**
   * The browser reports a finished payment. Its signature (order id, payment id, our secret) is checked before anything
   * changes, so a made-up "success" is refused. Webhooks reach the same settle step, and whichever arrives first wins.
   */
  async verify(user: AuthUser, input: VerifyInput): Promise<{ paymentStatus: string; appointmentStatus: string }> {
    const patientId = await this.patientIdFor(user.id);
    const payment = await this.payments.findOneBy({ razorpayOrderId: input.razorpayOrderId, patientId });
    if (!payment) throw new NotFoundException('Payment not found.');
    if (!checkoutSignatureValid(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature, this.config.payments.keySecret)) {
      this.logger.warn(`Rejected a payment signature for payment ${payment.id}.`);
      throw new BadRequestException('The payment could not be verified, so nothing was confirmed.');
    }
    return this.settlePaid(payment.id, input.razorpayPaymentId);
  }

  /**
   * Marks a payment PAID and confirms the booking, once however many times it is called (browser, webhook, retries).
   * If the booking was already released (expired or cancelled) while the payment was in flight, the money is refunded in full
   * instead of confirming a slot that may now belong to someone else.
   */
  async settlePaid(paymentId: string, razorpayPaymentId: string): Promise<{ paymentStatus: string; appointmentStatus: string }> {
    const refundIds: string[] = [];
    const result = await this.dataSource.transaction(async (manager) => {
      const { payment, appointment } = await this.lockAppointmentThenPayment(manager, paymentId);
      if (payment.status === 'PAID') {
        // Already settled. A DIFFERENT Razorpay payment id on a paid order would mean the customer was charged twice.
        if (payment.razorpayPaymentId !== razorpayPaymentId) {
          this.logger.error(`Order ${payment.razorpayOrderId} is already paid by ${payment.razorpayPaymentId}, but ${razorpayPaymentId} also arrived: check Razorpay for a duplicate charge.`);
        }
        return { paymentStatus: 'PAID', appointmentStatus: appointment.status };
      }

      payment.status = 'PAID';
      payment.razorpayPaymentId = razorpayPaymentId;
      payment.paidAt = new Date();
      payment.failureReason = null;
      await manager.save(payment);

      if (appointment.status === 'PENDING') {
        appointment.status = 'CONFIRMED';
        appointment.holdExpiresAt = null;
        await manager.save(appointment);
        await this.notifications.bookingConfirmed(manager, appointment.id);
        await this.notifications.paymentReceived(manager, appointment.id, { amountPaise: payment.amountPaise, receipt: razorpayPaymentId });
      } else if (appointment.status !== 'CONFIRMED') {
        const refund = await this.createRefund(
          manager,
          payment,
          { amountPaise: payment.amountPaise, percent: 100, reason: 'Full refund: the booking was released before the payment arrived.' },
          { key: `late:${payment.id}`, initiatedByUserId: null, appointmentId: appointment.id },
        );
        if (refund) refundIds.push(refund.id);
      }
      return { paymentStatus: 'PAID', appointmentStatus: appointment.status };
    });
    await this.runRefunds(refundIds);
    this.notifications.kick();
    return result;
  }

  // ---------------------------------------------------------------- Cancellation and rescheduling

  /**
   * Decides the money side of a cancellation, inside the cancelling transaction (the appointment row is already locked).
   * An unpaid hold simply stops accepting payment; a PAID booking is refunded according to the policy.
   */
  async onAppointmentCancelled(manager: EntityManager, appointment: Appointment, cancelledBy: CancelledBy, now = new Date()): Promise<CancellationOutcome> {
    const payment = await manager.findOne(Payment, {
      where: { appointmentId: appointment.id, status: In(['CREATED', 'FAILED', 'PAID']) },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) return { afterCommit: [] };
    if (payment.status !== 'PAID') {
      // A late payment on this order is still caught by settlePaid, which refunds it.
      payment.status = 'EXPIRED';
      await manager.save(payment);
      return { afterCommit: [] };
    }
    const decision = refundFor({
      paidPaise: payment.amountPaise,
      appointmentStart: zonedInstant(appointment.appointmentDate, hhmm(appointment.startTime), this.config.clinicTimezone),
      now,
      cancelledBy,
      policy: this.config.payments.refundPolicy,
    });
    if (decision.amountPaise <= 0) return { refundNote: decision.reason, afterCommit: [] };
    const refund = await this.createRefund(manager, payment, decision, { key: `cancel:${appointment.id}`, initiatedByUserId: null, appointmentId: appointment.id });
    return {
      refundNote: `${decision.reason} A refund of Rs. ${((refund?.amountPaise ?? decision.amountPaise) / 100).toFixed(2)} goes back to your original payment method.`,
      afterCommit: refund ? [refund.id] : [],
    };
  }

  /** After a reschedule the payment follows the patient to the new appointment: no refund and no second charge. */
  async moveToAppointment(manager: EntityManager, fromAppointmentId: string, toAppointmentId: string): Promise<void> {
    await manager.update(Payment, { appointmentId: fromAppointmentId, status: In(['CREATED', 'FAILED', 'PAID']) }, { appointmentId: toAppointmentId });
  }

  /** Sends refunds decided in a transaction to Razorpay, once that transaction has committed. Failures are retried by the worker. */
  async afterCommit(outcome: CancellationOutcome): Promise<void> {
    await this.runRefunds(outcome.afterCommit);
    this.notifications.kick();
  }

  /** Releases unpaid holds whose time has run out. Run by the background worker. */
  async expireHolds(now = new Date(), limit = 50): Promise<number> {
    const lapsed = await this.dataSource.getRepository(Appointment).find({
      select: { id: true },
      where: { status: 'PENDING', holdExpiresAt: LessThanOrEqual(now) },
      take: limit,
    });
    let released = 0;
    for (const { id } of lapsed) {
      released += await this.dataSource.transaction((manager) => this.cancelHold(manager, id, HOLD_CANCEL_REASON, now));
    }
    return released;
  }

  /**
   * Cancels an unpaid hold (only while it is still PENDING, and, with `onlyIfLapsedBy`, only if it has really run out) and
   * stops its order accepting payment. Lock order everywhere is appointment, then payment, then refund.
   */
  private async cancelHold(manager: EntityManager, appointmentId: string, reason: string, onlyIfLapsedBy: Date | null): Promise<number> {
    const appointment = await manager.findOne(Appointment, { where: { id: appointmentId }, lock: { mode: 'pessimistic_write' } });
    if (!appointment || appointment.status !== 'PENDING') return 0;
    if (onlyIfLapsedBy && !(appointment.holdExpiresAt && appointment.holdExpiresAt.getTime() <= onlyIfLapsedBy.getTime())) return 0;

    const payment = await manager.findOne(Payment, { where: { appointmentId, status: In(['CREATED', 'FAILED', 'PAID']) }, lock: { mode: 'pessimistic_write' } });
    if (payment?.status === 'PAID') return 0; // paid at the last moment: settlePaid confirms it, nothing to release
    if (payment) {
      payment.status = 'EXPIRED';
      await manager.save(payment);
    }
    appointment.status = 'CANCELLED';
    appointment.cancelReason = reason;
    appointment.cancelledAt = new Date();
    appointment.cancelledByUserId = appointment.bookedByUserId; // the constraint wants a person; the system acts for the booker here
    appointment.holdExpiresAt = null;
    await manager.save(appointment);
    await this.notifications.appointmentCancelled(manager, appointment.id, { cancelledBy: 'SYSTEM', reason });
    return 1;
  }

  // ---------------------------------------------------------------- Refunds

  /**
   * Records a refund (PENDING) inside the caller's transaction, capped so refunds can never add up to more than was paid.
   * The caller must already hold the payment row lock. A repeat with the same key returns the first refund instead.
   */
  private async createRefund(
    manager: EntityManager,
    payment: Payment,
    decision: RefundDecision,
    options: { key: string; initiatedByUserId: string | null; appointmentId: string },
  ): Promise<Refund | null> {
    const existing = await manager.findOneBy(Refund, { idempotencyKey: options.key });
    if (existing) return existing;
    const { taken } = (await manager
      .createQueryBuilder(Refund, 'refund')
      .select('COALESCE(SUM(refund.amountPaise), 0)', 'taken')
      .where('refund.paymentId = :id AND refund.status <> :failed', { id: payment.id, failed: 'FAILED' })
      .getRawOne<{ taken: string }>())!;
    const amountPaise = Math.min(decision.amountPaise, payment.amountPaise - Number(taken));
    if (amountPaise <= 0) return null;
    const refund = await manager.save(
      manager.create(Refund, { paymentId: payment.id, amountPaise, reason: decision.reason, idempotencyKey: options.key, initiatedByUserId: options.initiatedByUserId }),
    );
    await this.notifications.refundUpdated(manager, options.appointmentId, { id: refund.id, amountPaise, status: 'PENDING', reason: decision.reason });
    return refund;
  }

  /** An administrator refunds all or part of what is left on a paid payment. `requestId` makes a double submit harmless. */
  async refundAsAdmin(user: AuthUser, paymentId: string, input: { amountPaise?: number; reason: string; requestId: string }) {
    const created = await this.dataSource.transaction(async (manager) => {
      const known = await manager.findOne(Payment, { where: { id: paymentId } });
      if (!known) throw new NotFoundException('Payment not found.');
      const { payment, appointment } = await this.lockAppointmentThenPayment(manager, paymentId);
      if (payment.status !== 'PAID') throw new ConflictException('Only a paid payment can be refunded.');
      const key = `manual:${payment.id}:${input.requestId}`;
      const replay = await manager.findOneBy(Refund, { idempotencyKey: key });
      if (replay) return replay;

      const { taken } = (await manager
        .createQueryBuilder(Refund, 'refund')
        .select('COALESCE(SUM(refund.amountPaise), 0)', 'taken')
        .where('refund.paymentId = :id AND refund.status <> :failed', { id: payment.id, failed: 'FAILED' })
        .getRawOne<{ taken: string }>())!;
      const remaining = payment.amountPaise - Number(taken);
      if (remaining <= 0) throw new ConflictException('This payment has already been refunded in full.');
      const amountPaise = input.amountPaise ?? remaining;
      if (amountPaise > remaining) throw new BadRequestException(`Only Rs. ${(remaining / 100).toFixed(2)} is left to refund on this payment.`);
      const refund = await this.createRefund(
        manager,
        payment,
        { amountPaise, percent: Math.round((amountPaise / payment.amountPaise) * 100), reason: input.reason },
        { key, initiatedByUserId: user.id, appointmentId: appointment.id },
      );
      return refund!;
    });
    await this.runRefunds([created.id]);
    this.notifications.kick();
    return this.refundSummary(created.id);
  }

  private async refundSummary(id: string) {
    const refund = await this.refunds.findOneByOrFail({ id });
    return { id: refund.id, paymentId: refund.paymentId, amountPaise: refund.amountPaise, status: refund.status, reason: refund.reason, reference: refund.razorpayRefundId };
  }

  private async runRefunds(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.executeRefund(id).catch((error: Error) => this.logger.error(`Refund ${id} could not be sent: ${error.message}`));
    }
  }

  /**
   * Sends one PENDING refund to Razorpay, or asks Razorpay how it is going if it was already sent. It is only ever marked
   * PROCESSED from Razorpay's own answer. The idempotency key makes repeating this safe: Razorpay returns the same refund.
   */
  async executeRefund(refundId: string): Promise<void> {
    const refund = await this.refunds.findOne({ where: { id: refundId }, relations: { payment: true } });
    if (!refund || refund.status !== 'PENDING') return;
    if (!refund.payment.razorpayPaymentId) {
      await this.refunds.update(refund.id, { status: 'FAILED', failureReason: 'The payment has no Razorpay payment id.' });
      return;
    }
    let outcome: GatewayRefund;
    try {
      outcome = refund.razorpayRefundId ? await this.gateway.fetchRefund(refund.razorpayRefundId) : await this.sendRefund(refund, refund.payment.razorpayPaymentId);
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      const status = error instanceof GatewayError ? error.status : undefined;
      // Only a definite "no" from Razorpay is final: a 4xx other than 409 (a repeat still in progress) and 429 (slow down).
      // A timeout, a dropped connection or a 5xx leaves it unknown whether Razorpay made the refund, so it stays PENDING and is
      // retried (never marked FAILED, which would invite a manual second refund).
      const permanent = status !== undefined && status >= 400 && status < 500 && status !== 429 && status !== 409;
      await this.refunds.update(refund.id, permanent ? { status: 'FAILED', failureReason: message } : { failureReason: message });
      if (permanent) await this.announceRefund(refund.id);
      return;
    }
    await this.applyRefundResult(refund.id, outcome);
  }

  /**
   * Asks Razorpay to make the refund. The request is identical every time it is made for the same refund (same key, amount and
   * notes, none of which can change), which is what lets Razorpay recognise a repeat. If an earlier attempt may have reached
   * Razorpay without us hearing back, look for the refund first and adopt it rather than risk a second one.
   */
  private async sendRefund(refund: Refund, razorpayPaymentId: string): Promise<GatewayRefund> {
    const maybeAlreadySent = refund.failureReason !== null || Date.now() - refund.createdAt.getTime() > 30_000;
    if (maybeAlreadySent) {
      const existing = await this.gateway.findRefundByNote(razorpayPaymentId, refund.id);
      if (existing) return existing;
    }
    return this.gateway.createRefund({
      paymentId: razorpayPaymentId,
      amountPaise: refund.amountPaise,
      // One refund row = one Razorpay key, in the characters Razorpay allows. It never depends on anything that can change later.
      idempotencyKey: `rfnd-${refund.id}`,
      notes: { refundId: refund.id },
    });
  }

  /** Records what Razorpay said about a refund. Never moves a PROCESSED refund backwards, so repeats and late events are harmless. */
  private async applyRefundResult(refundId: string, result: GatewayRefund): Promise<void> {
    const changed = await this.dataSource.transaction(async (manager) => {
      const refund = await manager.findOne(Refund, { where: { id: refundId }, lock: { mode: 'pessimistic_write' } });
      if (!refund || refund.status === 'PROCESSED') return false;
      refund.razorpayRefundId = refund.razorpayRefundId ?? result.id;
      if (result.status === 'processed') {
        refund.status = 'PROCESSED';
        refund.processedAt = new Date();
        refund.failureReason = null;
      } else if (result.status === 'failed') {
        refund.status = 'FAILED';
        refund.failureReason = 'Razorpay could not complete the refund.';
      }
      await manager.save(refund);
      if (refund.status !== 'PENDING') await this.notifyRefund(manager, refund);
      return true;
    });
    if (changed) this.notifications.kick();
  }

  private async announceRefund(refundId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => this.notifyRefund(manager, await manager.findOneByOrFail(Refund, { id: refundId })));
    this.notifications.kick();
  }

  private async notifyRefund(manager: EntityManager, refund: Refund): Promise<void> {
    const payment = await manager.findOneByOrFail(Payment, { id: refund.paymentId });
    await this.notifications.refundUpdated(manager, payment.appointmentId, { id: refund.id, amountPaise: refund.amountPaise, status: refund.status, reason: refund.reason });
  }

  /** Background worker: re-sends refunds Razorpay never acknowledged and checks on ones it accepted but has not finished. */
  async settleRefunds(now = new Date(), limit = 20): Promise<number> {
    const waiting = await this.refunds.find({
      where: { status: 'PENDING', createdAt: LessThanOrEqual(new Date(now.getTime() - 60_000)) },
      order: { createdAt: 'ASC' },
      take: limit,
    });
    for (const refund of waiting) await this.executeRefund(refund.id).catch((error: Error) => this.logger.warn(`Refund ${refund.id}: ${error.message}`));
    return waiting.length;
  }

  // ---------------------------------------------------------------- Webhook

  /**
   * Handles a Razorpay webhook. The signature is checked against the exact bytes received, so nothing is trusted until it
   * proves it came from Razorpay. Redelivered events are acknowledged and ignored; handlers are also safe to repeat, so a
   * crash half way through is simply retried by Razorpay.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: unknown, eventIdHeader: unknown): Promise<{ received: true; duplicate?: true }> {
    if (!this.config.payments.webhookSecret) throw new ServiceUnavailableException('Webhooks are not configured.');
    if (!webhookSignatureValid(rawBody, signature, this.config.payments.webhookSecret)) {
      throw new UnauthorizedException('Invalid webhook signature.');
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(rawBody!.toString('utf8')) as WebhookEvent;
    } catch {
      throw new BadRequestException('The webhook body is not valid JSON.');
    }
    // Razorpay sends a unique id per event; hashing the body is the fallback so even a missing header cannot cause double handling.
    const eventId = typeof eventIdHeader === 'string' && eventIdHeader ? eventIdHeader.slice(0, 120) : `body:${createHash('sha256').update(rawBody!).digest('hex')}`;
    const type = (event.event ?? 'unknown').slice(0, 64);

    if (await this.dataSource.getRepository(PaymentEvent).existsBy({ eventId })) return { received: true, duplicate: true };
    await this.applyEvent(type, event);
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(PaymentEvent)
      .values({ eventId, eventType: type })
      .orIgnore()
      .execute();
    return { received: true };
  }

  private async applyEvent(type: string, event: WebhookEvent): Promise<void> {
    const paymentEntity = event.payload?.payment?.entity;
    const refundEntity = event.payload?.refund?.entity;

    if ((type === 'payment.captured' || type === 'order.paid') && paymentEntity?.id && paymentEntity.order_id) {
      const payment = await this.payments.findOneBy({ razorpayOrderId: paymentEntity.order_id });
      if (!payment) return; // not one of ours
      if (paymentEntity.amount !== payment.amountPaise || (paymentEntity.currency ?? 'INR') !== payment.currency) {
        this.logger.error(`Ignored a captured payment whose amount or currency does not match order ${payment.razorpayOrderId}.`);
        return;
      }
      await this.settlePaid(payment.id, paymentEntity.id);
    } else if (type === 'payment.failed' && paymentEntity?.order_id) {
      // Only an unpaid order can fail; a PAID or EXPIRED one is left alone. The patient may retry on the same order.
      await this.payments.update(
        { razorpayOrderId: paymentEntity.order_id, status: In(['CREATED', 'FAILED']) },
        { status: 'FAILED', failureReason: (paymentEntity.error_description ?? 'The payment failed.').slice(0, 300) },
      );
    } else if ((type === 'refund.processed' || type === 'refund.failed' || type === 'refund.created') && refundEntity?.id) {
      await this.applyRefundEvent(refundEntity.id, refundEntity.payment_id, refundEntity.amount, type);
    }
  }

  private async applyRefundEvent(razorpayRefundId: string, razorpayPaymentId: string | undefined, amountPaise: number | undefined, type: string): Promise<void> {
    const status: GatewayRefund['status'] = type === 'refund.processed' ? 'processed' : type === 'refund.failed' ? 'failed' : 'pending';
    const known = await this.refunds.findOneBy({ razorpayRefundId });
    if (known) return this.applyRefundResult(known.id, { id: razorpayRefundId, status, amountPaise: amountPaise ?? known.amountPaise });

    if (!razorpayPaymentId || !amountPaise) return;
    const payment = await this.payments.findOneBy({ razorpayPaymentId });
    if (!payment) return;
    // A refund made outside CareSlot (Razorpay dashboard) or whose id we never stored: record it so the history is complete.
    const key = `rzp:${razorpayRefundId}`;
    const created = await this.refunds.findOneBy({ idempotencyKey: key });
    const refund =
      created ??
      (await this.refunds.save(
        this.refunds.create({ paymentId: payment.id, amountPaise, reason: 'Refunded from the Razorpay dashboard.', idempotencyKey: key, razorpayRefundId }),
      ));
    await this.applyRefundResult(refund.id, { id: razorpayRefundId, status, amountPaise });
  }

  // ---------------------------------------------------------------- Reading

  /** Payment summaries keyed by appointment id, for attaching to appointment lists. */
  async summariesFor(appointmentIds: string[]): Promise<Map<string, PaymentSummary>> {
    const map = new Map<string, PaymentSummary>();
    if (appointmentIds.length === 0) return map;
    const rows = await this.payments.find({ where: { appointmentId: In(appointmentIds) }, relations: { refunds: true }, order: { createdAt: 'ASC' } });
    // A booking can have an old EXPIRED order and a newer live one: the latest row wins.
    for (const row of rows) map.set(row.appointmentId, toPaymentSummary(row));
    return map;
  }

  /**
   * The signed-in patient's payments with their refunds and receipts, newest first: paid and refunded ones, failed attempts, and
   * a booking still waiting for payment. Orders that were abandoned and never paid (the hold ran out) are left out.
   */
  async listForPatient(user: AuthUser) {
    const patientId = await this.patientIdFor(user.id);
    const rows = await this.payments.find({
      where: { patientId },
      relations: { refunds: true, appointment: { doctor: { user: true, clinic: true, specialty: true } } },
      order: { createdAt: 'DESC' },
    });
    return rows
      .filter(
        (row) =>
          row.status === 'PAID' ||
          row.status === 'FAILED' ||
          row.razorpayPaymentId !== null ||
          (row.status === 'CREATED' && row.appointment.status === 'PENDING'),
      )
      .map((row) => ({
        ...toPaymentSummary(row),
        createdAt: row.createdAt,
        appointment: {
          id: row.appointment.id,
          date: row.appointment.appointmentDate,
          startTime: hhmm(row.appointment.startTime),
          endTime: hhmm(row.appointment.endTime),
          status: row.appointment.status,
          doctorName: row.appointment.doctor.user.name,
          specialty: row.appointment.doctor.specialty.name,
          clinicName: row.appointment.doctor.clinic.name,
          clinicAddress: row.appointment.doctor.clinic.address,
        },
      }));
  }

  // ---------------------------------------------------------------- Internals

  /**
   * Locks the appointment, then its payment (the order every code path uses, so they cannot deadlock). A reschedule can move
   * the payment to a new appointment while we wait, so check the pair still matches and try again if not.
   */
  private async lockAppointmentThenPayment(manager: EntityManager, paymentId: string): Promise<{ payment: Payment; appointment: Appointment }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const unlocked = await manager.findOneByOrFail(Payment, { id: paymentId });
      const appointment = await manager.findOneOrFail(Appointment, { where: { id: unlocked.appointmentId }, lock: { mode: 'pessimistic_write' } });
      const payment = await manager.findOneOrFail(Payment, { where: { id: paymentId }, lock: { mode: 'pessimistic_write' } });
      if (payment.appointmentId === appointment.id) return { payment, appointment };
    }
    throw new ConflictException('This payment is being changed. Please try again.');
  }

  private async patientIdFor(userId: string): Promise<string> {
    const patient = await this.patients.findOneBy({ userId });
    if (!patient) throw new ForbiddenException('Only patients can make payments.');
    return patient.id;
  }
}

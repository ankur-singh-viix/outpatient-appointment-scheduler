import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In, LessThanOrEqual } from 'typeorm';
import { zonedInstant } from '../common/zoned-time.js';
import { loadConfig } from '../config.js';
import { Appointment, Notification } from '../database/entities/index.js';
import { hhmm } from '../scheduling/slots.js';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from './notification-channel.js';
import * as templates from './templates.js';
import type { AppointmentFacts, MessageContent } from './templates.js';

const MAX_ATTEMPTS = 5;
/** Minutes to wait after the 1st, 2nd, 3rd... failed attempt before trying again. */
const BACKOFF_MINUTES = [1, 5, 15, 60];

interface Loaded {
  appointmentId: string;
  facts: AppointmentFacts;
  patientEmail: string;
  start: Date;
}

interface Queued extends MessageContent {
  appointmentId: string;
  to: string;
  dedupeKey: string;
  sendAt?: Date;
}

export interface RefundFacts {
  id: string;
  amountPaise: number;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  reason: string;
}

/**
 * Every email CareSlot sends about an appointment goes through here. Messages are written to the `notifications` table
 * inside the caller's transaction (so they exist exactly when the change they describe does), then delivered afterwards
 * with retries. Each has a dedupe key, so replaying the same event can never send the same message twice.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');
  private readonly config = loadConfig();

  constructor(
    private readonly dataSource: DataSource,
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: NotificationChannel[],
  ) {}

  // ---- Events: call these inside the transaction that changes the appointment ----

  /** A confirmed booking: the confirmation email and the configured reminders. */
  async bookingConfirmed(manager: EntityManager, appointmentId: string, now = new Date()): Promise<void> {
    const loaded = await this.load(manager, appointmentId);
    await this.enqueue(manager, [
      { ...templates.bookingConfirmed(loaded.facts), ...this.address(loaded), dedupeKey: `booking-confirmed:${appointmentId}` },
      ...this.reminders(loaded, now),
    ]);
  }

  /** A cancellation: queues the cancellation email and withdraws every reminder that has not gone out yet. */
  async appointmentCancelled(
    manager: EntityManager,
    appointmentId: string,
    input: { cancelledBy: 'PATIENT' | 'DOCTOR' | 'SYSTEM'; reason: string; refundNote?: string },
  ): Promise<void> {
    await this.cancelReminders(manager, appointmentId);
    const loaded = await this.load(manager, appointmentId);
    await this.enqueue(manager, [
      { ...templates.bookingCancelled(loaded.facts, input), ...this.address(loaded), dedupeKey: `booking-cancelled:${appointmentId}` },
    ]);
  }

  /** A move to a new time: withdraws the old appointment's reminders and sets up the new one's. */
  async appointmentRescheduled(manager: EntityManager, oldAppointmentId: string, newAppointmentId: string, now = new Date()): Promise<void> {
    await this.cancelReminders(manager, oldAppointmentId);
    const previous = await this.load(manager, oldAppointmentId);
    const loaded = await this.load(manager, newAppointmentId);
    await this.enqueue(manager, [
      { ...templates.bookingRescheduled(loaded.facts, previous.facts), ...this.address(loaded), dedupeKey: `booking-rescheduled:${newAppointmentId}` },
      ...this.reminders(loaded, now),
    ]);
  }

  async paymentReceived(manager: EntityManager, appointmentId: string, input: { amountPaise: number; receipt: string }): Promise<void> {
    const loaded = await this.load(manager, appointmentId);
    await this.enqueue(manager, [
      { ...templates.paymentReceived(loaded.facts, input), ...this.address(loaded), dedupeKey: `payment-received:${input.receipt}` },
    ]);
  }

  /** One email per refund state change (started, processed, failed). */
  async refundUpdated(manager: EntityManager, appointmentId: string, refund: RefundFacts): Promise<void> {
    const loaded = await this.load(manager, appointmentId);
    await this.enqueue(manager, [
      { ...templates.refundUpdate(loaded.facts, refund), ...this.address(loaded), dedupeKey: `refund:${refund.id}:${refund.status}` },
    ]);
  }

  // ---- Delivery ----

  /**
   * Sends everything that is due. Rows are claimed with SKIP LOCKED, so two workers never send the same message. A failure
   * is retried with a growing delay and gives up after a few attempts; it never affects the booking or payment itself.
   */
  async dispatchDue(now = new Date(), limit = 25): Promise<{ sent: number; failed: number; skipped: number }> {
    const result = { sent: 0, failed: 0, skipped: 0 };
    await this.dataSource.transaction(async (manager) => {
      const due = await manager.find(Notification, {
        where: { status: 'PENDING', sendAt: LessThanOrEqual(now) },
        order: { sendAt: 'ASC' },
        take: limit,
        lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
      });
      for (const row of due) {
        // Belt and braces: a reminder for an appointment that is no longer active must never go out, even if it was missed above.
        if (row.kind === 'reminder' && !(await this.isActive(manager, row.appointmentId))) {
          row.status = 'CANCELLED';
          result.skipped++;
          await manager.save(row);
          continue;
        }
        const channel = this.channels.find((candidate) => candidate.name === row.channel);
        row.attempts += 1;
        try {
          if (!channel) throw new Error(`No "${row.channel}" channel is configured.`);
          await channel.send({ to: row.toAddress, subject: row.subject, body: row.body });
          row.status = 'SENT';
          row.sentAt = new Date();
          row.lastError = null;
          result.sent++;
        } catch (error) {
          row.lastError = (error as Error).message.slice(0, 500);
          if (row.attempts >= MAX_ATTEMPTS) row.status = 'FAILED';
          else row.sendAt = new Date(now.getTime() + (BACKOFF_MINUTES[row.attempts - 1] ?? 60) * 60_000);
          result.failed++;
          this.logger.warn(`Could not send ${row.kind} (attempt ${row.attempts}): ${row.lastError}`);
        }
        await manager.save(row);
      }
    });
    return result;
  }

  /** Best-effort immediate delivery after a commit; the background worker is the safety net. */
  kick(): void {
    if (!this.config.backgroundJobs) return;
    setImmediate(() => {
      this.dispatchDue().catch((error: Error) => this.logger.warn(`Delivery run failed: ${error.message}`));
    });
  }

  // ---- Internals ----

  private async cancelReminders(manager: EntityManager, appointmentId: string): Promise<void> {
    await manager.update(Notification, { appointmentId, kind: 'reminder', status: 'PENDING' }, { status: 'CANCELLED' });
  }

  private async isActive(manager: EntityManager, appointmentId: string | null): Promise<boolean> {
    if (!appointmentId) return false;
    return manager.exists(Appointment, { where: { id: appointmentId, status: In(['PENDING', 'CONFIRMED']) } });
  }

  private reminders(loaded: Loaded, now: Date): Queued[] {
    return this.config.reminderHoursBefore
      .map((hours) => ({ hours, sendAt: new Date(loaded.start.getTime() - hours * 3_600_000) }))
      .filter(({ sendAt }) => sendAt.getTime() > now.getTime())
      .map(({ hours, sendAt }) => ({
        ...templates.reminder(loaded.facts, hours),
        ...this.address(loaded),
        sendAt,
        dedupeKey: `reminder:${loaded.appointmentId}:${hours}`,
      }));
  }

  private address(loaded: Loaded): Pick<Queued, 'appointmentId' | 'to'> {
    return { appointmentId: loaded.appointmentId, to: loaded.patientEmail };
  }

  private async enqueue(manager: EntityManager, messages: Queued[]): Promise<void> {
    if (messages.length === 0) return;
    await manager
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values(
        messages.map((message) => ({
          appointmentId: message.appointmentId,
          channel: 'email',
          kind: message.kind,
          toAddress: message.to,
          subject: message.subject.slice(0, 200),
          body: message.body,
          sendAt: message.sendAt ?? new Date(),
          dedupeKey: message.dedupeKey,
        })),
      )
      .orIgnore() // a message with the same dedupe key already exists: replaying an event must not send it twice
      .execute();
  }

  private async load(manager: EntityManager, appointmentId: string): Promise<Loaded> {
    const appointment = await manager.findOneOrFail(Appointment, {
      where: { id: appointmentId },
      relations: { patient: { user: true }, doctor: { user: true, clinic: true } },
    });
    return {
      appointmentId,
      patientEmail: appointment.patient.user.email,
      start: zonedInstant(appointment.appointmentDate, hhmm(appointment.startTime), this.config.clinicTimezone),
      facts: {
        patientName: appointment.patient.user.name,
        doctorName: appointment.doctor.user.name,
        clinicName: appointment.doctor.clinic.name,
        clinicAddress: appointment.doctor.clinic.address,
        date: appointment.appointmentDate,
        startTime: hhmm(appointment.startTime),
      },
    };
  }
}

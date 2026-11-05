import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { zonedInstant } from '../common/zoned-time.js';
import { loadConfig } from '../config.js';
import { Appointment, Notification, NotificationPreference, Patient } from '../database/entities/index.js';
import { clinicNow } from '../scheduling/calendar.js';
import { hhmm } from '../scheduling/slots.js';
import { isRetryable } from './delivery-error.js';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from './notification-channel.js';
import {
  DEFAULT_PREFERENCES,
  categoryOf,
  mayDeliver,
  reminderSchedule,
  type ChannelName,
  type NotificationCategory,
  type NotificationPreferences,
} from './notification-policy.js';
import { canonicalHours, parseReminderKey, reminderKey, reminderSlot } from './reminder-keys.js';
import { normalisePhone } from './sms-provider.js';
import * as templates from './templates.js';
import type { AppointmentFacts, MessageContent } from './templates.js';

const BACKOFF_CAP_SECONDS = 60 * 60;
/** Why a message was cancelled because of the recipient's choices. Reminders cancelled for this reason can be restored if they opt back in. */
/** Why a pending reminder was cancelled because its interval was removed from REMINDER_HOURS_BEFORE. Restored if the interval comes back. */
const STALE_INTERVAL_SKIP = 'Not sent: this reminder interval is no longer configured.';
/** Why a second reminder for the same appointment, interval and channel was cancelled. */
const DUPLICATE_SKIP = 'Not sent: a duplicate of another reminder for the same appointment, interval and channel.';
const PREFERENCES_SKIP = "Not sent: the recipient's notification preferences do not allow this message.";

/**
 * How long to wait before the next try: the base delay, doubled after each failure, capped at an hour. With the default base
 * of 60 seconds: 1, 2, 4, 8, 16 minutes... `failedAttempts` is how many tries have failed so far (1 after the first failure).
 */
export function backoffSeconds(failedAttempts: number, baseSeconds: number): number {
  return Math.min(baseSeconds * 2 ** Math.max(failedAttempts - 1, 0), BACKOFF_CAP_SECONDS);
}

/** Someone a message can be for, with the contact details the channels need. */
interface Party {
  userId: string;
  role: 'PATIENT' | 'DOCTOR';
  name: string;
  email: string;
  phone: string | null;
  /** Their notification choices (the defaults for anyone who never changed them, and for doctors). */
  prefs: NotificationPreferences;
}

interface Loaded {
  appointmentId: string;
  /** The appointment's status right now. */
  status: string;
  facts: AppointmentFacts;
  patient: Party;
  doctor: Party;
  start: Date;
}

/** One message to one person on one channel, ready to be written to the outbox. */
interface Queued {
  appointmentId: string;
  party: Party;
  channel: 'email' | 'sms';
  category: NotificationCategory;
  kind: string;
  subject: string;
  body: string;
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
 * Every email and text CareSlot sends about an appointment goes through here. Messages are written to the `notifications` table
 * (the outbox) inside the caller's transaction, so they exist exactly when the change they describe does, then delivered
 * afterwards by `dispatchDue`, with retries. Each has a dedupe key, so replaying an event never sends the same message twice.
 *
 * Writing to the outbox can never break the booking, payment or refund it describes: each event runs in a savepoint, and if
 * anything in it fails the savepoint is rolled back, the error is logged, and the caller's transaction carries on untouched.
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

  /** A confirmed booking: the confirmation to the patient (email, and text when available) and a heads-up to the doctor, plus reminders. */
  async bookingConfirmed(manager: EntityManager, appointmentId: string, now = new Date()): Promise<void> {
    await this.safely(manager, `booking confirmation for ${appointmentId}`, async (inner) => {
      const loaded = await this.load(inner, appointmentId);
      await this.enqueue(inner, [
        ...this.toPatient(loaded, templates.bookingConfirmed(loaded.facts), `booking-confirmed:${appointmentId}`),
        ...this.toDoctor(loaded, templates.bookingConfirmed(loaded.facts, 'doctor'), `booking-confirmed:${appointmentId}`),
        ...this.reminders(loaded, now),
      ]);
    });
  }

  /** A cancellation: tells the patient and the doctor, and withdraws every reminder that has not gone out yet. */
  async appointmentCancelled(
    manager: EntityManager,
    appointmentId: string,
    input: { cancelledBy: 'PATIENT' | 'DOCTOR' | 'SYSTEM'; reason: string; refundNote?: string },
  ): Promise<void> {
    await this.safely(manager, `cancellation notice for ${appointmentId}`, async (inner) => {
      await this.cancelReminders(inner, appointmentId);
      const loaded = await this.load(inner, appointmentId);
      await this.enqueue(inner, [
        ...this.toPatient(loaded, templates.bookingCancelled(loaded.facts, input), `booking-cancelled:${appointmentId}`),
        ...this.toDoctor(loaded, templates.bookingCancelled(loaded.facts, input, 'doctor'), `booking-cancelled:${appointmentId}`),
      ]);
    });
  }

  /** A move to a new time: both people get the new details, and the old appointment's reminders are replaced by the new one's. */
  async appointmentRescheduled(manager: EntityManager, oldAppointmentId: string, newAppointmentId: string, now = new Date()): Promise<void> {
    await this.safely(manager, `reschedule notice for ${newAppointmentId}`, async (inner) => {
      await this.cancelReminders(inner, oldAppointmentId);
      const previous = await this.load(inner, oldAppointmentId);
      const loaded = await this.load(inner, newAppointmentId);
      await this.enqueue(inner, [
        ...this.toPatient(loaded, templates.bookingRescheduled(loaded.facts, previous.facts), `booking-rescheduled:${newAppointmentId}`),
        ...this.toDoctor(loaded, templates.bookingRescheduled(loaded.facts, previous.facts, 'doctor'), `booking-rescheduled:${newAppointmentId}`),
        ...this.reminders(loaded, now),
      ]);
    });
  }

  /** A successful payment: the receipt goes to the patient (the doctor learns of the paid booking from the confirmation). */
  async paymentReceived(manager: EntityManager, appointmentId: string, input: { amountPaise: number; receipt: string }): Promise<void> {
    await this.safely(manager, `payment receipt for ${appointmentId}`, async (inner) => {
      const loaded = await this.load(inner, appointmentId);
      await this.enqueue(inner, this.toPatient(loaded, templates.paymentReceived(loaded.facts, input), `payment-received:${input.receipt}`));
    });
  }

  /** A failed payment attempt. `attemptId` is the provider's id for that attempt, so each failure is reported once, and only once. */
  async paymentFailed(manager: EntityManager, appointmentId: string, input: { attemptId: string; reason?: string }): Promise<void> {
    await this.safely(manager, `payment failure notice for ${appointmentId}`, async (inner) => {
      const loaded = await this.load(inner, appointmentId);
      await this.enqueue(inner, this.toPatient(loaded, templates.paymentFailed(loaded.facts, { reason: input.reason }), `payment-failed:${input.attemptId}`));
    });
  }

  /** One message per refund state change (initiated, processed, failed), to the patient. */
  async refundUpdated(manager: EntityManager, appointmentId: string, refund: RefundFacts): Promise<void> {
    await this.safely(manager, `refund notice for ${appointmentId}`, async (inner) => {
      const loaded = await this.load(inner, appointmentId);
      await this.enqueue(inner, this.toPatient(loaded, templates.refundUpdate(loaded.facts, refund), `refund:${refund.id}:${refund.status}`));
    });
  }

  // ---- Delivery ----

  /**
   * Sends everything that is due. Rows are claimed with SKIP LOCKED, so two workers never send the same message.
   * - Success: SENT, with the provider's reference and the time.
   * - A temporary failure (timeout, rate limit, provider outage): tried again after an exponentially growing wait, until
   *   `maxAttempts` is used up.
   * - A permanent refusal (invalid recipient, unverified sender, bad credentials): FAILED at once, since retrying only repeats it.
   * A failed message is kept as it is, with its error, so it can be inspected and re-queued (see `requeueFailed`). Nothing here
   * can affect the booking or payment that caused the message.
   */
  async dispatchDue(now = new Date(), limit = 25): Promise<{ sent: number; failed: number; skipped: number }> {
    const result = { sent: 0, failed: 0, skipped: 0 };
    const { maxAttempts, retryBaseSeconds } = this.config.notifications;
    await this.dataSource.transaction(async (manager) => {
      const due = await manager.find(Notification, {
        where: { status: 'PENDING', sendAt: LessThanOrEqual(now) },
        order: { sendAt: 'ASC' },
        take: limit,
        lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
      });
      for (const row of due) {
        // Just before sending, look again: the recipient's current choices and, for a reminder, the appointment as it is now.
        const skip = await this.recheck(manager, row, now);
        if (skip) {
          row.status = 'CANCELLED';
          row.lastError = skip;
          result.skipped++;
          await manager.save(row);
          continue;
        }
        const channel = this.channels.find((candidate) => candidate.name === row.channel);
        row.attempts += 1;
        row.lastAttemptAt = now;
        try {
          if (!channel) throw new Error(`No "${row.channel}" channel is configured.`);
          const sent = await channel.send({ to: row.toAddress, subject: row.subject, body: row.body });
          row.status = 'SENT';
          row.sentAt = new Date();
          row.providerReference = sent.reference?.slice(0, 160) ?? null;
          row.lastError = null;
          result.sent++;
        } catch (error) {
          row.lastError = (error as Error).message.slice(0, 500);
          if (!isRetryable(error) || row.attempts >= maxAttempts) row.status = 'FAILED';
          else row.sendAt = new Date(now.getTime() + backoffSeconds(row.attempts, retryBaseSeconds) * 1000);
          result.failed++;
          this.logger.warn(`Could not send ${row.kind} by ${row.channel} (attempt ${row.attempts}${row.status === 'FAILED' ? ', giving up' : ''}): ${row.lastError}`);
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

  // ---- Monitoring ----

  /** Deliveries that gave up, newest first, for an operator to look at. */
  async listFailed(limit = 100) {
    const rows = await this.dataSource.getRepository(Notification).find({ where: { status: 'FAILED' }, order: { updatedAt: 'DESC' }, take: limit });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      channel: row.channel,
      recipientRole: row.recipientRole,
      to: row.toAddress,
      attempts: row.attempts,
      lastError: row.lastError,
      lastAttemptAt: row.lastAttemptAt,
      appointmentId: row.appointmentId,
      createdAt: row.createdAt,
    }));
  }

  /** Puts a failed delivery back in the queue for a fresh run of attempts. Only FAILED ones: a sent message is never sent twice. */
  async requeueFailed(id: string): Promise<{ id: string; status: 'PENDING' }> {
    const outcome = await this.dataSource
      .createQueryBuilder()
      .update(Notification)
      .set({ status: 'PENDING', attempts: 0, sendAt: () => 'now()' })
      .where('id = :id AND status = :failed', { id, failed: 'FAILED' })
      .execute();
    if (!outcome.affected) throw new NotFoundException('No failed notification with that id.');
    this.kick();
    return { id, status: 'PENDING' };
  }

  // ---- Reminder upkeep ----

  /**
   * Keeps reminders correct without anyone clicking, run by the existing background job (at start-up and every few minutes):
   * - cancels pending reminders whose appointment is no longer confirmed, whatever changed it (cancelled, completed, no-show...);
   * - schedules the reminders any confirmed upcoming appointment is missing: ones whose queueing failed, ones booked before
   *   reminders existed, and new intervals added to REMINDER_HOURS_BEFORE.
   * Both are safe to repeat: a reminder that already exists (even one cancelled by a preference) is never created again.
   */
  async maintainReminders(now = new Date()): Promise<{ cancelled: number; redundant: number; restored: number; scheduled: number }> {
    const cancelled = await this.cancelIneligibleReminders();
    const redundant = await this.cancelRedundantReminders();
    const restored = await this.restoreReaddedIntervals(now);
    const scheduled = await this.backfillReminders(now);
    return { cancelled, redundant, restored, scheduled };
  }

  /**
   * Keeps exactly one live reminder per appointment, interval and channel, and only for the intervals that are configured:
   * - a pending reminder whose interval has since been removed from REMINDER_HOURS_BEFORE is cancelled (it is no longer a valid
   *   reminder; this is what stops 24h + 2h + 1h piling up after the setting changes from "24,2" to "24,1");
   * - if two live rows describe the same appointment, interval and channel (however their keys were written), only one is kept:
   *   a sent one wins over a pending one, then the earliest.
   * Valid reminders for different intervals (the 24-hour and the 1-hour one) are different reminders and are never touched.
   */
  private async cancelRedundantReminders(): Promise<number> {
    const live = await this.dataSource.getRepository(Notification).find({
      select: { id: true, dedupeKey: true, status: true, channel: true },
      where: { kind: 'reminder', status: In(['PENDING', 'SENT']) },
      order: { createdAt: 'ASC' },
      take: 5000,
    });
    const configured = new Set(this.config.reminderHoursBefore.map(canonicalHours));
    const stale: string[] = [];
    const duplicates: string[] = [];
    const kept = new Map<string, { id: string; status: string }>();
    for (const row of live) {
      const parsed = parseReminderKey(row.dedupeKey);
      if (!parsed) continue; // not a key this code wrote: leave it alone
      if (row.status === 'PENDING' && !configured.has(canonicalHours(parsed.hours))) {
        stale.push(row.id);
        continue;
      }
      const slot = reminderSlot(parsed.appointmentId, parsed.hours, row.channel as 'email' | 'sms');
      const first = kept.get(slot);
      if (!first) kept.set(slot, { id: row.id, status: row.status });
      else if (row.status === 'PENDING') duplicates.push(row.id);
      else if (first.status === 'PENDING') {
        duplicates.push(first.id); // a sent reminder outranks a pending twin
        kept.set(slot, { id: row.id, status: row.status });
      }
    }
    if (stale.length > 0) await this.dataSource.manager.update(Notification, { id: In(stale) }, { status: 'CANCELLED', lastError: STALE_INTERVAL_SKIP });
    if (duplicates.length > 0) await this.dataSource.manager.update(Notification, { id: In(duplicates) }, { status: 'CANCELLED', lastError: DUPLICATE_SKIP });
    return stale.length + duplicates.length;
  }

  /** An interval removed and then added back: its reminders were cancelled as stale (their keys are still taken), so bring them back if not yet due. */
  private async restoreReaddedIntervals(now: Date): Promise<number> {
    const configured = new Set(this.config.reminderHoursBefore.map(canonicalHours));
    const candidates = await this.dataSource.manager.find(Notification, { where: { kind: 'reminder', status: 'CANCELLED', lastError: STALE_INTERVAL_SKIP, sendAt: MoreThanOrEqual(now) }, take: 2000 });
    const back = candidates.filter((row) => {
      const parsed = parseReminderKey(row.dedupeKey);
      return parsed !== null && configured.has(canonicalHours(parsed.hours));
    });
    if (back.length > 0) await this.dataSource.manager.update(Notification, { id: In(back.map((row) => row.id)) }, { status: 'PENDING', lastError: null });
    return back.length;
  }

  private async cancelIneligibleReminders(): Promise<number> {
    const stale = await this.dataSource
      .createQueryBuilder(Notification, 'n')
      .innerJoin(Appointment, 'a', 'a.id = n.appointmentId')
      .where("n.kind = 'reminder' AND n.status = 'PENDING' AND a.status <> 'CONFIRMED'")
      .select('n.id', 'id')
      .getRawMany<{ id: string }>();
    if (stale.length === 0) return 0;
    await this.dataSource.manager.update(Notification, { id: In(stale.map((row) => row.id)) }, { status: 'CANCELLED', lastError: 'Not sent: the appointment is no longer confirmed.' });
    return stale.length;
  }

  /**
   * Schedules the reminders confirmed upcoming appointments are missing. A reminder is identified by appointment, interval AND
   * channel, and which channels a patient should get depends on their choices (and on having a usable phone number and an SMS
   * service), so "missing" is worked out per channel: a text reminder that exists never stands in for an email one that is
   * missing, or the other way round. Returns how many appointments had reminders scheduled. `userId` limits it to one patient
   * (after they change their choices).
   */
  private async backfillReminders(now: Date, userId?: string): Promise<number> {
    const today = clinicNow(this.config.clinicTimezone).date;
    const appointments = await this.dataSource.getRepository(Appointment).find({
      relations: { patient: true },
      where: { status: 'CONFIRMED', appointmentDate: MoreThanOrEqual(today), ...(userId ? { patient: { userId } } : {}) },
      order: { appointmentDate: 'ASC', startTime: 'ASC' },
      take: 500,
    });
    if (appointments.length === 0) return 0;

    const existing = await this.dataSource.getRepository(Notification).find({
      select: { dedupeKey: true },
      where: { appointmentId: In(appointments.map((appointment) => appointment.id)), kind: 'reminder' },
    });
    // Every reminder that already exists (whatever its status: its key is taken either way), in canonical form ("24" = "24.0").
    const have = new Set(
      existing.flatMap((row) => {
        const parsed = parseReminderKey(row.dedupeKey);
        return parsed ? [reminderSlot(parsed.appointmentId, parsed.hours, parsed.channel)] : [];
      }),
    );

    const userIds = [...new Set(appointments.map((appointment) => appointment.patient.userId))];
    const saved = await this.dataSource.getRepository(NotificationPreference).find({ where: { userId: In(userIds) } });
    const choices = new Map<string, NotificationPreferences>(
      saved.map((row) => [row.userId, { smsEnabled: row.smsEnabled, emailReminders: row.emailReminders, smsReminders: row.smsReminders, promotionalEmail: row.promotionalEmail, promotionalSms: row.promotionalSms }]),
    );
    const smsAvailable = this.channels.find((channel) => channel.name === 'sms')?.enabled ?? false;

    let scheduled = 0;
    for (const appointment of appointments) {
      const prefs = choices.get(appointment.patient.userId) ?? DEFAULT_PREFERENCES;
      const wanted: ChannelName[] = [];
      if (mayDeliver(prefs, 'reminder', 'email')) wanted.push('email');
      if (smsAvailable && normalisePhone(appointment.patient.phone, this.config.sms.defaultCountryCode) && mayDeliver(prefs, 'reminder', 'sms')) wanted.push('sms');

      const start = zonedInstant(appointment.appointmentDate, hhmm(appointment.startTime), this.config.clinicTimezone);
      const missing = reminderSchedule(start, this.config.reminderHoursBefore, now).filter(({ hours }) =>
        wanted.some((channel) => !have.has(reminderSlot(appointment.id, hours, channel))),
      );
      if (missing.length === 0) continue;
      await this.dataSource.transaction((manager) =>
        this.safely(manager, `reminders for ${appointment.id}`, async (inner) => {
          await this.enqueue(inner, this.reminders(await this.load(inner, appointment.id), now));
        }),
      );
      scheduled++;
    }
    return scheduled;
  }

  // ---- Preferences ----

  /** The patient's choices, the dates of their promotional consents, and whether a text could reach them at all. */
  async getPreferences(userId: string) {
    const row = await this.dataSource.getRepository(NotificationPreference).findOneBy({ userId });
    const prefs = await this.preferencesOf(this.dataSource.manager, userId);
    const patient = await this.dataSource.getRepository(Patient).findOneBy({ userId });
    return {
      ...prefs,
      promotionalEmailConsentAt: row?.promotionalEmailConsentAt ?? null,
      promotionalSmsConsentAt: row?.promotionalSmsConsentAt ?? null,
      smsNumberOnFile: normalisePhone(patient?.phone, this.config.sms.defaultCountryCode) !== null,
      smsServiceAvailable: this.channels.find((channel) => channel.name === 'sms')?.enabled ?? false,
    };
  }

  /**
   * Saves the choices that were sent. Turning a promotional option on records when the patient did it (and turning it off clears
   * that), so consent is always a dated fact. The change takes effect straight away: messages already queued that the new choices
   * no longer allow are cancelled, and reminders the new choices now allow are scheduled.
   */
  async updatePreferences(userId: string, patch: Partial<NotificationPreferences>) {
    await this.dataSource.transaction(async (manager) => {
      const row =
        (await manager.findOneBy(NotificationPreference, { userId })) ??
        manager.create(NotificationPreference, { userId, ...DEFAULT_PREFERENCES, promotionalEmailConsentAt: null, promotionalSmsConsentAt: null });
      const now = new Date();
      if (patch.smsEnabled !== undefined) row.smsEnabled = patch.smsEnabled;
      if (patch.emailReminders !== undefined) row.emailReminders = patch.emailReminders;
      if (patch.smsReminders !== undefined) row.smsReminders = patch.smsReminders;
      if (patch.promotionalEmail !== undefined && patch.promotionalEmail !== row.promotionalEmail) {
        row.promotionalEmail = patch.promotionalEmail;
        row.promotionalEmailConsentAt = patch.promotionalEmail ? now : null;
      }
      if (patch.promotionalSms !== undefined && patch.promotionalSms !== row.promotionalSms) {
        row.promotionalSms = patch.promotionalSms;
        row.promotionalSmsConsentAt = patch.promotionalSms ? now : null;
      }
      await manager.save(row);
    });

    const prefs = await this.preferencesOf(this.dataSource.manager, userId);
    const pending = await this.dataSource.manager.find(Notification, { where: { recipientUserId: userId, status: 'PENDING' } });
    const blocked = pending.filter((row) => (row.category !== 'transactional' || row.channel === 'sms') && !mayDeliver(prefs, categoryOf(row.category), row.channel as ChannelName));
    if (blocked.length > 0) {
      await this.dataSource.manager.update(Notification, { id: In(blocked.map((row) => row.id)) }, { status: 'CANCELLED', lastError: PREFERENCES_SKIP });
    }
    // A reminder cancelled only because of an earlier choice comes back if the patient has changed their mind before it was due.
    // (Its dedupe key is still taken, so it has to be restored rather than created again.)
    const now = new Date();
    const optedOut = await this.dataSource.manager.find(Notification, { where: { recipientUserId: userId, kind: 'reminder', status: 'CANCELLED', lastError: PREFERENCES_SKIP, sendAt: MoreThanOrEqual(now) } });
    const restored = optedOut.filter((row) => mayDeliver(prefs, 'reminder', row.channel as ChannelName));
    if (restored.length > 0) await this.dataSource.manager.update(Notification, { id: In(restored.map((row) => row.id)) }, { status: 'PENDING', lastError: null });
    await this.backfillReminders(now, userId);
    return this.getPreferences(userId);
  }

  // ---- Internals ----

  /** Runs `work` in a savepoint: if it throws, only its own writes are undone, and the caller's transaction stays usable. */
  private async safely(manager: EntityManager, what: string, work: (inner: EntityManager) => Promise<void>): Promise<void> {
    try {
      await manager.transaction(work);
    } catch (error) {
      this.logger.error(`Could not queue the ${what}; the booking, payment or refund it describes is unaffected: ${(error as Error).message}`);
    }
  }

  private async cancelReminders(manager: EntityManager, appointmentId: string): Promise<void> {
    await manager.update(Notification, { appointmentId, kind: 'reminder', status: 'PENDING' }, { status: 'CANCELLED' });
  }

  /**
   * Whether a message due now should really go out, or why not (it is then cancelled with that reason, never failed or retried).
   * 1. The recipient's choices as they are NOW: someone may have opted out, or withdrawn consent, since it was queued. Essential
   *    emails need no check, because they are always sent.
   * 2. For a reminder, the appointment as it is NOW: it must still be confirmed and not yet started, and the message is rebuilt
   *    from the current time, doctor, clinic and how far away it is, so it can never describe a stale appointment.
   */
  private async recheck(manager: EntityManager, row: Notification, now: Date): Promise<string | null> {
    const category = categoryOf(row.category);
    if (category !== 'transactional' || row.channel === 'sms') {
      const prefs = row.recipientUserId ? await this.preferencesOf(manager, row.recipientUserId) : DEFAULT_PREFERENCES;
      if (!mayDeliver(prefs, category, row.channel as ChannelName)) return PREFERENCES_SKIP;
    }
    if (row.kind === 'reminder') {
      if (!row.appointmentId) return 'Not sent: the reminder has no appointment.';
      const current = await this.load(manager, row.appointmentId).catch(() => null);
      if (!current) return 'Not sent: the appointment no longer exists.';
      if (current.status !== 'CONFIRMED') return `Not sent: the appointment is ${current.status.toLowerCase().replace('_', ' ')}.`;
      if (current.start.getTime() <= now.getTime()) return 'Not sent: the appointment has already started.';
      const content = templates.reminder(current.facts, (current.start.getTime() - now.getTime()) / 3_600_000);
      row.subject = content.subject.slice(0, 200);
      row.body = row.channel === 'sms' ? content.sms : content.body;
    }
    return null;
  }

  private async preferencesOf(manager: EntityManager, userId: string): Promise<NotificationPreferences> {
    const row = await manager.findOneBy(NotificationPreference, { userId });
    return row
      ? { smsEnabled: row.smsEnabled, emailReminders: row.emailReminders, smsReminders: row.smsReminders, promotionalEmail: row.promotionalEmail, promotionalSms: row.promotionalSms }
      : { ...DEFAULT_PREFERENCES };
  }

  /** The reminders for an appointment: one per configured interval that is still in the future, to the patient by whichever channels they allow. */
  private reminders(loaded: Loaded, now: Date): Queued[] {
    return reminderSchedule(loaded.start, this.config.reminderHoursBefore, now).flatMap(({ hours, sendAt }) =>
      this.toPatient(loaded, templates.reminder(loaded.facts, hours), reminderKey(loaded.appointmentId, hours), 'reminder', sendAt),
    );
  }

  private email(loaded: Loaded, party: Party, content: MessageContent, dedupeKey: string, category: NotificationCategory = 'transactional', sendAt?: Date): Queued {
    return { appointmentId: loaded.appointmentId, party, channel: 'email', category, kind: content.kind, subject: content.subject, body: content.body, dedupeKey, sendAt };
  }

  /**
   * The patient's copies: an email, and a text if SMS is set up and they gave a usable phone number. The email keeps the plain key
   * (so messages queued before doctors and texts existed are never repeated); the text adds ":sms".
   */
  private toPatient(loaded: Loaded, content: MessageContent, baseKey: string, category: NotificationCategory = 'transactional', sendAt?: Date): Queued[] {
    const { prefs } = loaded.patient;
    const messages: Queued[] = [];
    if (mayDeliver(prefs, category, 'email')) messages.push(this.email(loaded, loaded.patient, content, baseKey, category, sendAt));
    const smsChannel = this.channels.find((channel) => channel.name === 'sms');
    const phone = normalisePhone(loaded.patient.phone, this.config.sms.defaultCountryCode);
    if (smsChannel?.enabled && phone && content.sms && mayDeliver(prefs, category, 'sms')) {
      messages.push({
        appointmentId: loaded.appointmentId,
        party: { ...loaded.patient, phone },
        channel: 'sms',
        category,
        kind: content.kind,
        subject: content.subject,
        body: content.sms,
        dedupeKey: `${baseKey}:sms`,
        sendAt,
      });
    }
    return messages;
  }

  /** The doctor's copy: email only (doctors have no phone number on record). */
  private toDoctor(loaded: Loaded, content: MessageContent, baseKey: string): Queued[] {
    return [this.email(loaded, loaded.doctor, content, `${baseKey}:doctor`)];
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
          channel: message.channel,
          category: message.category,
          recipientUserId: message.party.userId,
          recipientRole: message.party.role,
          kind: message.kind,
          // An email goes to the address on the account; a text goes to the (normalised) phone number.
          toAddress: message.channel === 'sms' ? message.party.phone! : message.party.email,
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
    const patientPrefs = await this.preferencesOf(manager, appointment.patient.user.id);
    return {
      appointmentId,
      status: appointment.status,
      start: zonedInstant(appointment.appointmentDate, hhmm(appointment.startTime), this.config.clinicTimezone),
      patient: {
        userId: appointment.patient.user.id,
        role: 'PATIENT',
        name: appointment.patient.user.name,
        email: appointment.patient.user.email,
        phone: appointment.patient.phone,
        prefs: patientPrefs,
      },
      doctor: {
        userId: appointment.doctor.user.id,
        role: 'DOCTOR',
        name: appointment.doctor.user.name,
        email: appointment.doctor.user.email,
        phone: null,
        prefs: { ...DEFAULT_PREFERENCES },
      },
      facts: {
        patientName: appointment.patient.user.name,
        doctorName: appointment.doctor.user.name,
        clinicName: appointment.doctor.clinic.name,
        clinicAddress: appointment.doctor.clinic.address,
        date: appointment.appointmentDate,
        startTime: hhmm(appointment.startTime),
        endTime: hhmm(appointment.endTime),
      },
    };
  }
}


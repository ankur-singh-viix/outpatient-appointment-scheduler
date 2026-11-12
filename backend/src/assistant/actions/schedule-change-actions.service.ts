import { ConflictException, ForbiddenException, GoneException, HttpException, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../../auth/auth.types.js';
import { loadConfig } from '../../config.js';
import { Doctor } from '../../database/entities/index.js';
import { AvailabilityChangeService } from '../../doctor-portal/availability-change.service.js';
import { dateLabel, rangeLabel, timeLabel, type ActionCard } from './action-cards.js';

/** How many affected patients the card lists by name (the count always covers all of them). */
const CARD_PATIENTS = 8;
/** The database stamps a change with its own clock, the token with this server's: allow for the two to differ a little. */
const CLOCK_SKEW_SECONDS = 300;

/** What a signed confirmation carries. Everything the confirmation will do is in here, and the signature stops anyone editing it. */
interface Payload {
  v: 1;
  /** The doctor's user the confirmation was made for. */
  u: string;
  /** The availability row (session) to change. */
  a: string;
  /** The new hours. */
  s: string;
  e: string;
  /** The first date the new hours apply to. */
  f: string;
  /** The hours the doctor previewed against (the session as it was). */
  c: { startTime: string; endTime: string };
  /** What the preview said it would do: the kind of change, and how many booked / waiting appointments it touches. */
  k: 'EXPAND' | 'SHRINK' | 'MIXED';
  n: number;
  r: number;
  /** The doctor's most recent schedule change when the preview was made (null when there was none). Any later change makes this stale. */
  l: string | null;
  /** Issued at, and expires at (ms since 1970). */
  i: number;
  x: number;
}

export interface PrepareInput {
  availabilityId: string;
  startTime: string;
  endTime: string;
  applyFrom?: string;
}

export type PrepareOutcome =
  | { prepared: true; card: ActionCard; summary: Record<string, unknown> }
  | { prepared: false; problems: string[] };

export interface ScheduleChangeResult {
  kind: 'SCHEDULE_CHANGE';
  outcome: 'DONE';
  message: string;
  changeId: string | null;
  alreadyApplied: boolean;
  affectedAppointments: number;
  patientsAsked: number;
  restoredAppointments: number;
}

/**
 * Doctor schedule changes (shrinking or extending a session) prepared by the assistant and applied only when the doctor presses
 * Confirm. Nothing here changes the schedule or messages anyone itself: preparing is a read-only preview from
 * AvailabilityChangeService, and confirming calls that same service's apply(), which re-checks everything under its own lock, requires
 * the acknowledgement, writes the audit row and hands the patients to the existing notifier.
 *
 * No table is involved. The confirmation is a signed, expiring token (HMAC over the stored request, keyed from the server secret), so
 * the browser can hold it but not alter it or use it for another doctor. Single use comes from the schedule itself: the token is
 * bound to the doctor's latest schedule change and to the session's hours at preview time, so once it has been used (or anything else
 * changed the schedule) it no longer matches and is refused, and a repeat of an already-applied change is answered, not run again.
 */
@Injectable()
export class ScheduleChangeActionsService {
  private readonly logger = new Logger(ScheduleChangeActionsService.name);
  private readonly config = loadConfig();
  private readonly key = createHmac('sha256', this.config.jwtSecret).update('assistant-schedule-change-v1').digest();

  constructor(
    private readonly dataSource: DataSource,
    private readonly changes: AvailabilityChangeService,
  ) {}

  /** Previews the change and, when it can be applied, issues the signed confirmation. Writes nothing. */
  async prepare(user: AuthUser, input: PrepareInput): Promise<PrepareOutcome> {
    const preview = await this.changes.preview(user, input.availabilityId, { startTime: input.startTime, endTime: input.endTime, applyFrom: input.applyFrom });
    if (!preview.canApply || preview.kind === 'NONE') return { prepared: false, problems: preview.problems.length > 0 ? preview.problems : ['Nothing would change.'] };

    const now = Date.now();
    const payload: Payload = {
      v: 1,
      u: user.id,
      a: input.availabilityId,
      s: preview.proposed.startTime,
      e: preview.proposed.endTime,
      f: preview.applyFrom,
      c: preview.current,
      k: preview.kind,
      n: preview.affectedCount,
      r: preview.restoredCount,
      l: await this.latestChange(user.id),
      i: now,
      x: now + this.config.assistant.confirmationMinutes * 60_000,
    };

    const when = preview.row.recurrence === 'ONE_TIME' ? `${dateLabel(preview.row.date as string)} only` : `every ${weekday(preview.row.dayOfWeek)}, from ${dateLabel(preview.applyFrom)}`;
    const names = new Map<string, number>();
    const patients = preview.affectedAppointments.slice(0, CARD_PATIENTS).map((appointment) => {
      const base = `${dateLabel(appointment.date)} ${timeLabel(appointment.startTime)}`;
      const seen = (names.get(base) ?? 0) + 1;
      names.set(base, seen);
      const options = appointment.alternatives.slice(0, 3).map((slot) => `${dateLabel(slot.date)} ${timeLabel(slot.startTime)}`);
      return { label: seen > 1 ? `${base} (${seen})` : base, value: `${appointment.patient.name}: ${options.length > 0 ? `could move to ${options.join(', ')}` : 'no other time is open yet'}` };
    });

    const lines: ActionCard['lines'] = [
      { label: 'Session', value: `${preview.row.mode === 'WAVE' ? 'Wave' : 'Stream'} session, ${when}` },
      { label: 'Hours', value: `${rangeLabel(preview.current.startTime, preview.current.endTime)} → ${rangeLabel(preview.proposed.startTime, preview.proposed.endTime)}` },
      { label: 'Slots', value: `${preview.addedSlots} added, ${preview.removedSlots} removed (${preview.affectedDates} date${preview.affectedDates === 1 ? '' : 's'})` },
    ];
    if (preview.splitsAtDate) lines.push({ label: 'Earlier dates', value: 'Keep their current hours' });
    if (preview.affectedCount > 0) {
      lines.push({ label: 'Booked patients affected', value: `${preview.affectedCount}: they stay booked and are emailed to choose a new time` });
      if (preview.withoutAlternatives > 0) lines.push({ label: 'No other time open', value: `${preview.withoutAlternatives} of the patients listed below` });
      lines.push(...patients);
      if (preview.affectedCount > patients.length) lines.push({ label: 'And', value: `${preview.affectedCount - patients.length} more patient${preview.affectedCount - patients.length === 1 ? '' : 's'}` });
    } else {
      lines.push({ label: 'Booked patients affected', value: 'None' });
    }
    if (preview.restoredCount > 0) lines.push({ label: 'Valid again', value: `${preview.restoredCount} waiting appointment${preview.restoredCount === 1 ? '' : 's'} fit these hours and are released` });

    const card: ActionCard = {
      ref: this.sign(payload),
      kind: 'SCHEDULE_CHANGE',
      title: preview.kind === 'EXPAND' ? 'Extend session hours' : preview.kind === 'SHRINK' ? 'Shorten session hours' : 'Change session hours',
      lines,
      note: 'Nothing is cancelled or moved. Confirmed appointments stay booked until each patient chooses a new time. Emails are sent after you confirm.',
      confirmLabel: preview.affectedCount > 0 ? `Confirm and notify ${preview.affectedCount} patient${preview.affectedCount === 1 ? '' : 's'}` : 'Confirm change',
      dismissLabel: 'Cancel',
      expiresAt: new Date(payload.x).toISOString(),
    };
    // What the model is told: counts only. Patient names and contact details stay on the doctor's card.
    const summary = {
      kind: preview.kind,
      from: preview.current,
      to: preview.proposed,
      appliesFrom: preview.applyFrom,
      slotsAdded: preview.addedSlots,
      slotsRemoved: preview.removedSlots,
      bookedPatientsAffected: preview.affectedCount,
      affectedWithNoOtherTimeOpen: preview.withoutAlternatives,
      waitingAppointmentsMadeValid: preview.restoredCount,
    };
    return { prepared: true, card, summary };
  }

  /**
   * The doctor pressed Confirm. Verifies the token, then re-checks that the schedule is exactly as previewed before applying it through
   * AvailabilityChangeService. Anything that no longer matches is refused with nothing changed.
   */
  async confirm(user: AuthUser, token: string): Promise<ScheduleChangeResult> {
    const payload = this.verify(token);
    if (payload.u !== user.id) throw new ForbiddenException('This confirmation was not made for you.');
    if (Date.now() >= payload.x) throw new GoneException('This confirmation has expired.');

    const doctorId = await this.doctorId(user.id);
    // A repeat of a change that already went through is answered, never run again.
    if ((await this.latestChange(user.id)) !== payload.l) {
      const done = await this.alreadyApplied(user.id, doctorId, payload);
      if (done) return done;
      throw stale('The schedule changed after this was prepared.');
    }

    // The same preview as when the card was made. If bookings or hours moved, the doctor is shown it again rather than acknowledging blind.
    const fresh = await this.changes.preview(user, payload.a, { startTime: payload.s, endTime: payload.e, applyFrom: payload.f });
    if (fresh.current.startTime !== payload.c.startTime || fresh.current.endTime !== payload.c.endTime) throw stale('The session hours changed after this was prepared.');
    if (!fresh.canApply) throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'SCHEDULE_CHANGE_REFUSED', message: `${fresh.problems.join(' ') || 'This change can no longer be applied.'} Nothing was changed.` });
    if (fresh.kind !== payload.k || fresh.affectedCount !== payload.n || fresh.restoredCount !== payload.r) {
      throw stale(`It would now affect ${fresh.affectedCount} booked patient${fresh.affectedCount === 1 ? '' : 's'}, not ${payload.n}.`);
    }

    try {
      // The doctor saw the list of affected patients on the card and pressed Confirm, which is the acknowledgement: given only when
      // there are patients to acknowledge, so a booking that slips in after the preview makes apply() refuse rather than be accepted unseen.
      const result = await this.changes.apply(user, payload.a, { startTime: payload.s, endTime: payload.e, applyFrom: payload.f, from: payload.c, acknowledge: payload.n > 0 });
      return {
        kind: 'SCHEDULE_CHANGE',
        outcome: 'DONE',
        message: doneMessage(result),
        changeId: result.changeId,
        alreadyApplied: false,
        affectedAppointments: result.affectedAppointments,
        patientsAsked: result.patientsAsked,
        restoredAppointments: result.restoredAppointments,
      };
    } catch (error) {
      // Two confirmations at once: the loser finds the hours already changed. If that change is this one, say so instead of failing.
      if (error instanceof ConflictException) {
        const done = await this.alreadyApplied(user.id, doctorId, payload);
        if (done) return done;
      }
      if (!(error instanceof HttpException)) this.logger.error(`Applying a prepared schedule change failed (${error instanceof Error ? error.name : 'error'}).`);
      throw error;
    }
  }

  // ---- the token ----

  private sign(payload: Payload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }

  /** Returns the payload only if the signature is genuine and the shape is right. Anything else is "not valid", with no detail. */
  private verify(token: string): Payload {
    const invalid = () => new HttpException({ statusCode: 400, error: 'Bad Request', code: 'INVALID_CONFIRMATION', message: 'This confirmation is not valid.' }, 400);
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) throw invalid();
    const expected = createHmac('sha256', this.key).update(body).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Payload;
      if (payload.v !== 1 || typeof payload.u !== 'string' || typeof payload.a !== 'string' || typeof payload.x !== 'number' || typeof payload.n !== 'number') throw invalid();
      return payload;
    } catch {
      throw invalid();
    }
  }

  // ---- reads ----

  private async doctorId(userId: string): Promise<string> {
    const doctor = await this.dataSource.getRepository(Doctor).findOne({ where: { userId }, select: { id: true } });
    if (!doctor) throw new ForbiddenException('No doctor profile is linked to this account.');
    return doctor.id;
  }

  /** The id of this doctor's most recent schedule change, or null when there has been none. */
  private async latestChange(userId: string): Promise<string | null> {
    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT c.id FROM schedule_changes c JOIN doctors d ON d.id = c.doctor_id WHERE d.user_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 1`,
      [userId],
    );
    return rows[0]?.id ?? null;
  }

  /** A change by this doctor, since the token was issued, that left the schedule exactly as the token asks. */
  private async alreadyApplied(userId: string, doctorId: string, payload: Payload): Promise<ScheduleChangeResult | null> {
    const rows: { id: string; affected_count: number }[] = await this.dataSource.query(
      `SELECT id, affected_count FROM schedule_changes
        WHERE doctor_id = $1 AND created_by_user_id = $2 AND apply_from = $3::date AND new_start_time = $4::time AND new_end_time = $5::time
          AND created_at >= to_timestamp($6 / 1000.0) - make_interval(secs => $7)
        ORDER BY created_at DESC LIMIT 1`,
      [doctorId, userId, payload.f, payload.s, payload.e, payload.i, CLOCK_SKEW_SECONDS],
    );
    if (!rows[0]) return null;
    return {
      kind: 'SCHEDULE_CHANGE',
      outcome: 'DONE',
      message: 'This change was already applied, so nothing was repeated.',
      changeId: rows[0].id,
      alreadyApplied: true,
      affectedAppointments: rows[0].affected_count,
      patientsAsked: rows[0].affected_count,
      restoredAppointments: 0,
    };
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (day: number | null): string => (day === null ? 'day' : WEEKDAYS[day]);

const stale = (why: string) =>
  new ConflictException({ statusCode: 409, error: 'Conflict', code: 'SCHEDULE_CHANGE_STALE', message: `${why} Nothing was changed. Ask me to prepare it again to see the current picture.` });

function doneMessage(result: { kind: string; addedSlots: number; removedSlots: number; affectedAppointments: number; patientsAsked: number; restoredAppointments: number }): string {
  const parts = [`Done. The session hours are updated (${result.addedSlots} slots added, ${result.removedSlots} removed).`];
  if (result.patientsAsked > 0) {
    parts.push(
      `${result.patientsAsked} booked appointment${result.patientsAsked === 1 ? ' stays' : 's stay'} booked, and ${result.patientsAsked === 1 ? 'that patient is' : 'those patients are'} being emailed to choose a new time. Ask me to check scheduling conflicts to see who has been reached.`,
    );
  }
  if (result.restoredAppointments > 0) parts.push(`${result.restoredAppointments} waiting appointment${result.restoredAppointments === 1 ? ' is' : 's are'} valid again.`);
  return parts.join(' ');
}

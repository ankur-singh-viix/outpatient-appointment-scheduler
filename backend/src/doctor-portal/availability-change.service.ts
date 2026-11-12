import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, In, MoreThanOrEqual, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { ACTIVE_STATUSES, Appointment, Availability, Doctor, Notification, ScheduleChange, ScheduleOverride, slotIntervalOf } from '../database/entities/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { MAX_NEW_TIME_REMINDERS } from '../notifications/templates.js';
import { addDays, clinicNow, isValidDate } from '../scheduling/calendar.js';
import { toRule } from '../scheduling/day-schedule.js';
import { findAffected, findRestored, planChange, slotsOn, type ElasticDoctor, type OpenSlot, type Placed, type Window } from '../scheduling/elastic.js';
import { describeBlock, whenText, windowLimit, type WindowBlock } from '../scheduling/change-window.js';
import { inheritedSettings, type AvailabilityRule } from '../scheduling/availability-rules.js';
import { appointmentsOutsideHours, toOverride } from '../scheduling/outside-hours.js';
import { reconcileCoverage } from '../scheduling/schedule-reconciler.js';
import { rescheduleLink, ScheduleChangeNotifier } from '../scheduling/schedule-change-notifier.service.js';
import { bookedLoader, openTimes, type BookedOn } from '../scheduling/open-times.js';
import { hhmm, placesTaken, toMinutes, type DateOverride } from '../scheduling/slots.js';

export interface ChangeInput {
  startTime: string;
  endTime: string;
  /** Recurring sessions only: the first date the new hours apply to. Earlier dates keep their hours. Defaults to today. */
  applyFrom?: string;
}

export interface ApplyChangeInput extends ChangeInput {
  /** The hours the doctor previewed against. If the session has changed since, the change is refused rather than applied blindly. */
  from: Window;
  /** Required when reducing the hours would leave booked appointments outside them: the doctor has seen the list and agrees. */
  acknowledge?: boolean;
}

/** How many example dates a preview lists (the totals always cover every date). */
const PREVIEW_DAYS = 12;
/** How many affected appointments a preview lists in full (the count always covers all of them). */
const PREVIEW_APPOINTMENTS = 50;
/** How many alternative times are offered for each affected appointment. */
const ALTERNATIVES = 5;
/** Rows read per step when scanning a doctor's upcoming appointments for ones outside the hours. */
const SCAN_CHUNK = 500;
export const OUTSIDE_PAGE = 25;

/** The context a plan or a list needs about one doctor right now. Appointments are not part of it: they are read as needed. */
export interface Situation {
  doctor: Doctor;
  elastic: ElasticDoctor;
  clock: { date: string; time: string };
  lastDate: string;
  rules: AvailabilityRule[];
}

/**
 * Changing the hours of an availability row after patients have booked it ("elastic scheduling"). A change is previewed first,
 * from the same engine patients are offered slots from; applying it re-checks everything inside a transaction that holds the
 * doctor row lock bookings take, so a booking in flight either finishes first (and is counted) or waits and sees the new hours.
 *
 * Appointments are never moved, changed or cancelled here. Extending hours only adds slots. Reducing hours stops new bookings in
 * the removed time at once, leaves every existing appointment booked, records each one as waiting for a new time, and hands the
 * asking to a background job (ScheduleChangeNotifier), so the request itself never sends mail or waits on thousands of notices.
 * The patient chooses a new time through the normal reschedule flow, which is their confirmation. Cancelling remains the doctor's
 * own last resort, with its reason, notice and refund, through the existing cancel action.
 */
@Injectable()
export class AvailabilityChangeService {
  private readonly config = loadConfig();

  constructor(
    @InjectRepository(Doctor) private readonly doctors: Repository<Doctor>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly notifier: ScheduleChangeNotifier,
  ) {}

  /** What a change would do, without doing anything. */
  async preview(user: AuthUser, id: string, input: ChangeInput) {
    const manager = this.dataSource.manager;
    return this.describe(manager, await this.plan(manager, user, id, input));
  }

  /** Makes the change and records the appointments it leaves outside the hours. Returns what it did. */
  async apply(user: AuthUser, id: string, input: ApplyChangeInput) {
    let doctorId = '';
    const result = await this.dataSource.transaction(async (manager) => {
      const planned = await this.plan(manager, user, id, input, { lock: true });
      doctorId = planned.doctor.id;
      const now = { startTime: hhmm(planned.row.startTime), endTime: hhmm(planned.row.endTime) };
      if (now.startTime !== input.from.startTime || now.endTime !== input.from.endTime) {
        throw new ConflictException('This session changed since you previewed it. Preview the change again.');
      }
      if (planned.restriction) throw tooClose(planned.restriction);
      const view = await this.describe(manager, planned);
      if (!view.canApply) throw new BadRequestException(view.problems.join(' ') || 'Nothing to change.');
      if (view.affectedCount > 0 && !input.acknowledge) {
        throw new ConflictException(
          `${view.affectedCount} booked appointment${view.affectedCount === 1 ? '' : 's'} would fall outside the new hours. Review ${view.affectedCount === 1 ? 'it' : 'them'} and confirm that you understand ${view.affectedCount === 1 ? 'it stays' : 'they stay'} booked until the patient chooses a new time.`,
        );
      }

      const { row, applyFrom, split } = planned;
      const proposed = { startTime: input.startTime, endTime: input.endTime };
      let resultId = row.id;
      if (!split) {
        await manager.update(Availability, { id: row.id }, proposed);
      } else {
        // Recurring: the old row ends the day before and a new one starts, so earlier dates keep exactly the hours they had.
        const copy = manager.create(Availability, {
          doctorId: row.doctorId,
          recurrenceType: row.recurrenceType,
          dayOfWeek: row.dayOfWeek,
          specificDate: row.specificDate,
          capacity: row.capacity,
          schedulingMode: row.schedulingMode,
          slotDurationMinutes: row.slotDurationMinutes,
          capacityPerSlot: row.capacityPerSlot,
          effectiveFrom: applyFrom,
          effectiveTo: row.effectiveTo,
          ...proposed,
        });
        await manager.update(Availability, { id: row.id }, { effectiveTo: addDays(applyFrom, -1) });
        resultId = (await manager.save(copy)).id;
        // Appointments from the first new date on now belong to the new row; earlier ones keep the old one.
        await manager
          .createQueryBuilder()
          .update(Appointment)
          .set({ availabilityId: resultId })
          .where('availability_id = :old AND appointment_date >= :applyFrom AND status IN (:...statuses)', { old: row.id, applyFrom, statuses: ACTIVE_STATUSES })
          .execute();
      }

      // The audit row, and one tracking row per affected appointment. Both are plain inserts: the patients are asked later, in the
      // background, so nothing here sends a message or waits on one.
      const change = await this.recordChange(
        manager,
        user,
        planned.doctor.id,
        { availabilityId: resultId, kind: view.kind === 'NONE' ? 'SHRINK' : view.kind, applyFrom, old: { start: now.startTime, end: now.endTime }, now: { start: hhmm(input.startTime), end: hhmm(input.endTime) } },
        planned.affectedIds,
      );
      // Extending (or the extending side of a mixed change): appointments that were waiting for a new time and are inside the hours
      // again are released here, in the same transaction, so nobody ever sees the new hours with the old bookkeeping.
      const widened = view.kind === 'EXPAND' || view.kind === 'MIXED';
      const released = widened ? await this.release(manager, planned.doctor.id, planned.situation.clock) : { restored: 0, withdrawn: 0, more: false };
      return {
        id: resultId,
        changeId: change.id,
        kind: view.kind,
        split,
        applyFrom,
        addedSlots: view.addedSlots,
        removedSlots: view.removedSlots,
        affectedAppointments: view.affectedCount,
        patientsAsked: view.affectedCount,
        restoredAppointments: released.restored,
        withdrawnNotices: released.withdrawn,
      };
    });
    // Best effort and outside the transaction: start asking now rather than waiting for the next background pass. A failure here
    // only delays the notices, because the rows are saved and the background job picks them up.
    if (result.patientsAsked > 0 && this.config.backgroundJobs) void this.notifier.drain(1).catch(() => undefined);
    if (result.restoredAppointments > 0) this.notifications.kick(); // start sending the "valid again" messages now
    if ((result.kind === 'EXPAND' || result.kind === 'MIXED') && this.config.backgroundJobs) void this.notifier.recover(doctorId).catch(() => undefined);
    return result;
  }

  /**
   * Booked appointments that are outside the doctor's hours as they are right now (after reducing hours, or taking a day off),
   * a page at a time in date order, with times that are still open and whether the patient has been asked to choose a new one.
   */
  async outsideHours(user: AuthUser, options: { cursor?: string; limit?: number } = {}) {
    const manager = this.dataSource.manager;
    const doctor = await this.requireDoctor(manager, user);
    const situation = await this.situation(manager, doctor);
    const limit = Math.min(Math.max(options.limit ?? OUTSIDE_PAGE, 1), 100);
    const { found, next } = await this.scanOutside(manager, situation, options.cursor, limit);
    const targets = found.length ? await this.withPatients(manager, found.map((entry) => entry.id)) : [];
    const overrides = await this.overridesFor(manager, doctor.id, situation.clock.date, situation.lastDate);
    const alternatives = await this.alternatives(targets, situation, situation.rules, overrides, bookedLoader(manager, doctor.id, situation.lastDate));

    const asked = new Map<string, { at: Date; status: string }>();
    const waiting = new Set<string>();
    const contacts_ = new Map<string, { reminders: number; last: Date }>();
    const cutoff = new Date(Date.now() - this.config.scheduleReminderCooldownHours * 3_600_000);
    if (targets.length > 0) {
      const ids = targets.map((target) => target.id);
      // A message withdrawn before it was sent (the hours were widened) is not a request the patient ever received.
      const requests = await manager.find(Notification, { where: { appointmentId: In(ids), kind: 'needs-new-time', channel: 'email', status: In(['PENDING', 'SENT', 'FAILED']) }, order: { createdAt: 'ASC' } });
      for (const request of requests) if (request.appointmentId) asked.set(request.appointmentId, { at: request.createdAt, status: request.status });
      const open: { appointment_id: string }[] = await manager.query(
        `SELECT appointment_id FROM schedule_change_appointments WHERE appointment_id = ANY($1::uuid[]) AND resolved_at IS NULL AND notified_at IS NULL`,
        [ids],
      );
      for (const row of open) waiting.add(row.appointment_id);
      const contacts = await manager.find(Notification, { where: { appointmentId: In(ids), kind: In(['needs-new-time', 'needs-new-time-reminder', 'new-times-available']), channel: 'email', status: In(['PENDING', 'SENT']) } });
      for (const contact of contacts) {
        if (!contact.appointmentId) continue;
        const entry = contacts_.get(contact.appointmentId) ?? { reminders: 0, last: new Date(0) };
        if (contact.kind === 'needs-new-time-reminder') entry.reminders++;
        if (contact.createdAt > entry.last) entry.last = contact.createdAt;
        contacts_.set(contact.appointmentId, entry);
      }
    }
    return {
      appointments: targets.map((appointment) => ({
        ...appointmentView(appointment),
        alternatives: alternatives.get(appointment.id) ?? [],
        asked: asked.get(appointment.id) ?? null,
        /** True while the notice is queued but not yet handed to the outbox by the background job. */
        noticePending: waiting.has(appointment.id),
        /** Where this patient stands, so the doctor knows who needs a personal follow-up (see followUpState). */
        followUp: followUpState({
          alternatives: (alternatives.get(appointment.id) ?? []).length,
          asked: asked.has(appointment.id) || waiting.has(appointment.id),
          reminders: contacts_.get(appointment.id)?.reminders ?? 0,
          lastContact: contacts_.get(appointment.id)?.last ?? null,
          cutoff,
        }),
      })),
      nextCursor: next,
    };
  }

  /**
   * What needs the doctor's attention, for the dashboard: patients still needing a new time; patients who have not answered even the
   * second reminder (so a personal call or a cancellation is the doctor's decision); and patients for whom no other time is open.
   */
  async attention(user: AuthUser) {
    const doctor = await this.requireDoctor(this.dataSource.manager, user);
    const clock = clinicNow(this.config.clinicTimezone);
    const cutoff = new Date(Date.now() - this.config.scheduleReminderCooldownHours * 3_600_000);
    const [row]: { needs: string; silent: string; stuck: string }[] = await this.dataSource.query(
      `WITH waiting AS (
         SELECT DISTINCT a.id FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id
          WHERE a.doctor_id = $1 AND s.resolved_at IS NULL AND a.status IN ('PENDING', 'CONFIRMED')
            AND (a.appointment_date > $2::date OR (a.appointment_date = $2::date AND a.start_time > $3::time)))
       SELECT count(*) AS needs,
              count(*) FILTER (WHERE (SELECT count(*) FROM notifications n WHERE n.appointment_id = w.id AND n.kind = 'needs-new-time-reminder' AND n.status IN ('PENDING', 'SENT')) >= $5
                                 AND (SELECT max(n.created_at) FROM notifications n WHERE n.appointment_id = w.id AND n.kind IN ('needs-new-time', 'needs-new-time-reminder', 'new-times-available') AND n.status IN ('PENDING', 'SENT')) <= $4) AS silent,
              count(*) FILTER (WHERE (SELECT max(n.created_at) FROM notifications n WHERE n.appointment_id = w.id AND n.kind = 'no-alternatives')
                                   > coalesce((SELECT max(n.created_at) FROM notifications n WHERE n.appointment_id = w.id AND n.kind = 'new-times-available' AND n.status IN ('PENDING', 'SENT')), '-infinity'::timestamptz)) AS stuck
         FROM waiting w`,
      [doctor.id, clock.date, clock.time, cutoff, MAX_NEW_TIME_REMINDERS],
    );
    return { needsNewTime: Number(row.needs), noResponse: Number(row.silent), noAlternatives: Number(row.stuck) };
  }

  /** The most recent schedule changes of this doctor, with how many of the affected appointments are still unresolved. */
  async history(user: AuthUser, limit = 10) {
    const doctor = await this.requireDoctor(this.dataSource.manager, user);
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT c.id, c.kind, c.apply_from::text AS "applyFrom", to_char(c.old_start_time, 'HH24:MI') AS "oldStart", to_char(c.old_end_time, 'HH24:MI') AS "oldEnd",
              to_char(c.new_start_time, 'HH24:MI') AS "newStart", to_char(c.new_end_time, 'HH24:MI') AS "newEnd", c.affected_count AS "affected", c.created_at AS "createdAt",
              count(s.*) FILTER (WHERE s.resolved_at IS NULL) AS "unresolved",
              count(s.*) FILTER (WHERE s.resolution = 'RESCHEDULED') AS "rescheduled",
              count(s.*) FILTER (WHERE s.resolution = 'CANCELLED') AS "cancelled",
              -- Appointments this change released: closed as COVERED in the very transaction that applied it (now() is that transaction's
              -- start for both timestamps). Ones released later by the background sweep are not credited to a particular change.
              CASE WHEN c.kind = 'SHRINK' THEN 0 ELSE
                (SELECT count(DISTINCT r.appointment_id) FROM schedule_changes c2 JOIN schedule_change_appointments r ON r.change_id = c2.id
                  WHERE c2.doctor_id = c.doctor_id AND r.resolution = 'COVERED' AND r.resolved_at = c.created_at) END AS "restored"
         FROM schedule_changes c LEFT JOIN schedule_change_appointments s ON s.change_id = c.id
        WHERE c.doctor_id = $1
        GROUP BY c.id ORDER BY c.created_at DESC LIMIT $2`,
      [doctor.id, Math.min(Math.max(limit, 1), 50)],
    );
    return {
      changes: rows.map((row) => ({ ...row, unresolved: Number(row.unresolved), rescheduled: Number(row.rescheduled), cancelled: Number(row.cancelled), restored: Number(row.restored) })),
    };
  }

  /** Asks the patient again (at most once a day) to choose a new time. The patient browses the open times and picks for themselves. */
  async askNewTime(user: AuthUser, appointmentId: string) {
    const asked = await this.dataSource.transaction(async (manager) => {
      const doctor = await this.requireDoctor(manager, user, true);
      const appointment = await manager.findOne(Appointment, { where: { id: appointmentId, doctorId: doctor.id }, relations: { patient: { user: true } } });
      if (!appointment) throw new NotFoundException('Appointment not found.');
      const situation = await this.situation(manager, doctor);
      const live = ACTIVE_STATUSES.includes(appointment.status) && !(appointment.status === 'PENDING' && appointment.holdExpiresAt !== null && appointment.holdExpiresAt.getTime() <= Date.now());
      const notStarted = appointment.appointmentDate > situation.clock.date || (appointment.appointmentDate === situation.clock.date && hhmm(appointment.startTime) > situation.clock.time);
      if (!live || !notStarted) throw new ConflictException('This appointment is not active or has already started.');
      if ((await appointmentsOutsideHours(manager, doctor.id, [placed(appointment)])).size === 0) {
        throw new ConflictException('This appointment is within your hours, so there is nothing to ask the patient.');
      }
      // At most one request a day per patient, counting the one sent when the hours changed.
      const recent = await manager.findOne(Notification, {
        where: { appointmentId: appointment.id, kind: In(['needs-new-time', 'needs-new-time-reminder', 'new-times-available']), channel: 'email', status: In(['PENDING', 'SENT']), createdAt: MoreThanOrEqual(new Date(Date.now() - 24 * 3_600_000)) },
        order: { createdAt: 'DESC' },
      });
      if (recent) throw new ConflictException('You have already asked this patient in the last 24 hours. Their email may still be on its way.');
      const changeKey = `ask-${situation.clock.date}`;
      await this.notifications.appointmentNeedsNewTime(manager, appointment.id, {
        link: rescheduleLink(this.config.frontendUrl, doctor.id, appointment.id),
        changeKey,
      });
      return true;
    });
    if (asked) this.notifications.kick();
    return { asked };
  }

  // ---- Changes other than "adjust the hours of one session": date exceptions, and removing or editing a session ----
  //
  // They all go through the same safe workflow as Adjust hours: the doctor row lock, an exact what-if on the real slot rules (so only
  // appointments that genuinely fall outside are affected), the minimum-notice window, an explicit acknowledgement, and then a
  // schedule_changes audit row with one tracking row per affected appointment, so each patient is emailed and chooses a new time.
  // Nothing here moves or cancels an appointment.

  /** Creates or replaces the exception for one date (a day off, a blocked time or replacement hours). */
  async setOverride(user: AuthUser, input: OverrideInput, acknowledge = false) {
    const after: DateOverride = {
      isAvailable: input.isAvailable,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      capacity: input.isAvailable ? (input.capacity ?? null) : null,
      reason: input.reason?.trim() || null,
    };
    return this.changeDate(
      user,
      input.date,
      after,
      acknowledge,
      async (manager, doctor) => {
        await manager.upsert(
          ScheduleOverride,
          { doctorId: doctor.id, overrideDate: input.date, isAvailable: after.isAvailable, startTime: after.startTime, endTime: after.endTime, capacity: after.capacity, reason: after.reason },
          ['doctorId', 'overrideDate'],
        );
      },
      (live, situation) => {
        // Replacement hours of a one-patient-per-slot day cap the whole day: not below the bookings already made in them.
        if (!input.isAvailable || !input.startTime || !input.endTime || !input.capacity) return;
        const inherited = inheritedSettings(situation.rules, input.date, { consultationMinutes: situation.doctor.consultationMinutes, defaultCapacity: situation.doctor.defaultDailyCapacity });
        if (inherited.mode !== 'STREAM') return;
        const inside = live.filter((a) => hhmm(a.startTime) >= input.startTime! && hhmm(a.startTime) < input.endTime!).length;
        if (inside > input.capacity) throw capacityBelowBookings(`${whenText(input.date, input.startTime!)}: ${inside} booked in these hours, and you asked for room for ${input.capacity}. Keep at least ${inside}.`);
      },
    );
  }

  /** Removes the exception for one date (the normal weekly hours apply again). */
  async removeOverride(user: AuthUser, date: string, acknowledge = false) {
    return this.changeDate(user, date, null, acknowledge, async (manager, doctor) => {
      const result = await manager.delete(ScheduleOverride, { doctorId: doctor.id, overrideDate: date });
      if (!result.affected) throw new NotFoundException('No exception exists for that date.');
    });
  }

  /**
   * Removes a one-time session. If patients have booked in it, they stay booked: each is recorded and asked to choose a new time,
   * after the doctor agrees. (Cancelling is the doctor's separate, last-resort action.)
   */
  async removeOneTimeSession(user: AuthUser, id: string, acknowledge = false) {
    const result = await this.dataSource.transaction(async (manager) => {
      const doctor = await this.requireDoctor(manager, user, true);
      const row = await manager.findOneBy(Availability, { id, doctorId: doctor.id, recurrenceType: 'ONE_TIME' });
      if (!row || !row.specificDate) throw new NotFoundException('No one-time session exists with that id.');
      return this.removeRow(manager, user, doctor, await this.situation(manager, doctor), row, acknowledge);
    });
    this.afterCommit(result);
    return result;
  }

  /** Called after a transaction that may have recorded affected appointments or released waiting ones. */
  afterCommit(result: { patientsAsked: number; restoredAppointments: number }, widenedFor?: string): void {
    if (result.patientsAsked > 0 && this.config.backgroundJobs) void this.notifier.drain(1).catch(() => undefined);
    if (result.restoredAppointments > 0) this.notifications.kick();
    // Hours or capacity were widened: patients who had no other time may have one now. A failure here only delays it (the job repeats it).
    if (widenedFor && this.config.backgroundJobs) void this.notifier.recover(widenedFor).catch(() => undefined);
  }

  /** The upcoming appointments booked into this row's sessions (inside its hours, on its days). Empty when nobody has booked. */
  async liveBookingsIn(manager: EntityManager, doctor: Doctor, row: Availability, situation?: Situation): Promise<Appointment[]> {
    const context = situation ?? (await this.situation(manager, doctor));
    return this.candidates(manager, row, { startTime: hhmm(row.startTime), endTime: hhmm(row.startTime) }, context.clock.date, context);
  }

  /**
   * What replacing the weekly sessions would do to the rows that are not simply kept, for rows with upcoming bookings:
   * - a row with the same hours and only its places per slot changed is updated in place, never below the bookings already made;
   * - any other change to its hours, slot length or dates is refused, and the doctor is sent to Adjust hours (which keeps bookings);
   * - a row that is removed is ended from today through the removal workflow (bookings stay, patients are asked).
   * Rows nobody has booked are left to the caller to delete and insert, exactly as before. Returns what the caller must not delete or insert.
   */
  async guardWeeklyReplace(
    manager: EntityManager,
    user: AuthUser,
    doctor: Doctor,
    args: { remove: Availability[]; add: { dayOfWeek: number | null; startTime: string; endTime: string; slotDurationMinutes: number | null; capacityPerSlot: number; capacity: number | null; schedulingMode: 'STREAM' | 'WAVE'; effectiveFrom: string | null; effectiveTo: string | null }[]; acknowledge: boolean },
  ): Promise<{ handledRowIds: Set<string>; handledInserts: Set<number>; results: { patientsAsked: number; restoredAppointments: number }[] }> {
    const handledRowIds = new Set<string>();
    const handledInserts = new Set<number>();
    const results: { patientsAsked: number; restoredAppointments: number }[] = [];
    if (args.remove.length === 0) return { handledRowIds, handledInserts, results };
    const situation = await this.situation(manager, doctor);
    for (const old of args.remove) {
      const live = await this.liveBookingsIn(manager, doctor, old, situation);
      if (live.length === 0) continue;
      const label = old.dayOfWeek !== null ? DAYS[old.dayOfWeek] : 'This session';
      const sameDay = args.add.map((row, index) => ({ row, index })).filter((entry) => entry.row.dayOfWeek === old.dayOfWeek && !handledInserts.has(entry.index));
      const sameHours = sameDay.find((entry) => hhmm(entry.row.startTime) === hhmm(old.startTime) && hhmm(entry.row.endTime) === hhmm(old.endTime));
      if (sameHours) {
        const next = sameHours.row;
        if (next.slotDurationMinutes !== old.slotDurationMinutes || next.effectiveFrom !== old.effectiveFrom || next.effectiveTo !== old.effectiveTo) {
          throw useAdjustHours(`${label} ${hhmm(old.startTime)}-${hhmm(old.endTime)} has ${live.length} upcoming booking${live.length === 1 ? '' : 's'}, so its slot length or dates cannot be changed here.`);
        }
        this.assertFits(live, next.schedulingMode === 'STREAM' ? next.capacity : null);
        await manager.update(Availability, { id: old.id }, { schedulingMode: next.schedulingMode, capacityPerSlot: next.capacityPerSlot, capacity: next.capacity });
        handledRowIds.add(old.id);
        handledInserts.add(sameHours.index);
        continue;
      }
      if (sameDay.length > 0) {
        throw useAdjustHours(`${label} ${hhmm(old.startTime)}-${hhmm(old.endTime)} has ${live.length} upcoming booking${live.length === 1 ? '' : 's'}, so its hours cannot be changed here.`);
      }
      results.push(await this.removeRow(manager, user, doctor, situation, old, args.acknowledge));
      handledRowIds.add(old.id);
    }
    return { handledRowIds, handledInserts, results };
  }

  /**
   * The total of a one-patient-per-slot session may rise freely but not fall below the bookings already made. (Places per slot may
   * fall below them: see setCapacity. Nobody is cancelled, and the slot takes no new bookings until it has room again.)
   */
  private assertFits(live: Appointment[], sessionCapacity: number | null): void {
    const byDate = new Map<string, Appointment[]>();
    for (const a of live) byDate.set(a.appointmentDate, [...(byDate.get(a.appointmentDate) ?? []), a]);
    for (const [date, list] of [...byDate].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (sessionCapacity !== null && list.length > sessionCapacity) {
        throw capacityBelowBookings(`${whenText(date, '00:00').split(' at ')[0]} already has ${list.length} booked in this session, and you asked for room for ${sessionCapacity}. Keep at least ${list.length}.`);
      }
    }
  }

  /**
   * Sets the patients per slot of one Wave session. Raising it opens the extra places at once. Lowering it never cancels or moves
   * anyone: bookings above the new limit stay, those slots are over capacity and take no new bookings until enough patients have
   * left them (cancelled, moved or finished), because places taken are always counted live from the bookings. It runs under the doctor
   * row lock that bookings take, so a booking and a capacity change can never interleave.
   */
  async setCapacity(user: AuthUser, id: string, capacityPerSlot: number) {
    return this.dataSource.transaction(async (manager) => {
      const doctor = await this.requireDoctor(manager, user, true);
      const row = await manager.findOneBy(Availability, { id, doctorId: doctor.id });
      if (!row) throw new NotFoundException('No session exists with that id.');
      if (row.schedulingMode !== 'WAVE') throw new BadRequestException('Only a Wave session has a patients-per-slot setting.');
      const previous = row.capacityPerSlot;
      if (capacityPerSlot !== previous) await manager.update(Availability, { id }, { capacityPerSlot });
      const load = slotLoad(await this.liveBookingsIn(manager, doctor, row), capacityPerSlot);
      return { id, capacityPerSlot, previousCapacityPerSlot: previous, overCapacitySlots: load.overCapacity?.slots ?? 0, maxBooked: load.maxBooked };
    });
  }

  /** For the doctor's session list: the busiest upcoming slot of each Wave session, and whether any slot is over its capacity. */
  async bookingLoad(doctor: Doctor, rows: Availability[]) {
    const manager = this.dataSource.manager;
    const situation = await this.situation(manager, doctor);
    const result = new Map<string, ReturnType<typeof slotLoad>>();
    for (const row of rows) if (row.schedulingMode === 'WAVE') result.set(row.id, slotLoad(await this.liveBookingsIn(manager, doctor, row, situation), row.capacityPerSlot));
    return result;
  }

  /** Ends a weekly session from today (or deletes a one-time one), recording the appointments it strands. Runs in the caller's transaction. */
  private async removeRow(manager: EntityManager, user: AuthUser, doctor: Doctor, situation: Situation, row: Availability, acknowledge: boolean) {
    const today = situation.clock.date;
    const live = await this.liveBookingsIn(manager, doctor, row, situation);
    const afterRules = situation.rules.filter((rule) => rule.id !== row.id);
    const overrides = await this.overridesFor(manager, doctor.id, today, situation.lastDate);
    const affectedIds = findAffected({ appointments: live.map(placed), rules: situation.rules, afterRules, overrides, doctor: situation.elastic });
    const block = await this.windowBlock(manager, situation, { afterRules, fromDate: today });
    if (block) throw tooClose(block);
    if (affectedIds.length > 0 && !acknowledge) throw await this.acknowledgeRequired(manager, affectedIds);

    // A weekly session that has already started is ended the day before (its past stays as history); one that starts later, or a
    // one-time session, is deleted (appointments keep their history; they just lose the link to the removed row).
    const endsYesterday = row.recurrenceType === 'WEEKLY' && (row.effectiveFrom === null || row.effectiveFrom <= today);
    let availabilityId: string | null = row.id;
    if (endsYesterday) await manager.update(Availability, { id: row.id }, { effectiveTo: addDays(today, -1) });
    else {
      await manager.delete(Availability, { id: row.id });
      availabilityId = null;
    }
    let changeId: string | null = null;
    if (affectedIds.length > 0) {
      // A removed session leaves no hours: recorded as an empty window at its start.
      const change = await this.recordChange(
        manager,
        user,
        doctor.id,
        {
          availabilityId,
          kind: 'SHRINK',
          applyFrom: row.recurrenceType === 'ONE_TIME' ? (row.specificDate as string) : today,
          old: { start: hhmm(row.startTime), end: hhmm(row.endTime) },
          now: { start: hhmm(row.startTime), end: hhmm(row.startTime) },
        },
        affectedIds,
      );
      changeId = change.id;
    }
    return { changeId, removed: true, affectedAppointments: affectedIds.length, patientsAsked: affectedIds.length, restoredAppointments: 0 };
  }

  /** The common path for a change to one date's exception. */
  private async changeDate(
    user: AuthUser,
    date: string,
    after: DateOverride | null,
    acknowledge: boolean,
    write: (manager: EntityManager, doctor: Doctor) => Promise<void>,
    check?: (live: Appointment[], situation: Situation) => void,
  ) {
    let doctorId = '';
    const result = await this.dataSource.transaction(async (manager) => {
      const doctor = await this.requireDoctor(manager, user, true);
      doctorId = doctor.id;
      const situation = await this.situation(manager, doctor);
      const before = await this.overridesFor(manager, doctor.id, date, date);
      const withAfter = (overrides: Map<string, DateOverride>) => {
        const copy = new Map(overrides);
        if (after) copy.set(date, after);
        else copy.delete(date);
        return copy;
      };
      const live = await this.liveUpcoming(manager, doctor.id, situation.clock)
        .select(['a.id', 'a.appointmentDate', 'a.startTime', 'a.endTime', 'a.slotNumber'])
        .andWhere('a.appointmentDate = :date', { date })
        .getMany();
      const what = { appointments: live.map(placed), rules: situation.rules, afterRules: situation.rules, overrides: before, afterOverrides: withAfter(before), doctor: situation.elastic };
      const affectedIds = findAffected(what);
      const restoredIds = findRestored(what);

      const block = await this.windowBlock(manager, situation, { afterRules: situation.rules, afterOverrides: withAfter });
      if (block) throw tooClose(block);
      check?.(live, situation);
      if (affectedIds.length > 0 && !acknowledge) throw await this.acknowledgeRequired(manager, affectedIds);

      await write(manager, doctor);

      let changeId: string | null = null;
      if (affectedIds.length > 0 || restoredIds.length > 0) {
        const spanOf = (override: DateOverride | null) => {
          const sessions = slotsOn(date, situation.rules, override, situation.elastic).sessions;
          return sessions.length ? { start: sessions.map((s) => hhmm(s.startTime)).sort()[0], end: sessions.map((s) => hhmm(s.endTime)).sort().at(-1) as string } : null;
        };
        const was = spanOf(before.get(date) ?? null);
        const will = spanOf(after);
        const old = was ?? will ?? { start: '00:00', end: '00:00' };
        const now = will ?? { start: old.start, end: old.start }; // a day off leaves no hours: an empty window
        const kind = affectedIds.length > 0 && restoredIds.length > 0 ? 'MIXED' : affectedIds.length > 0 ? 'SHRINK' : 'EXPAND';
        const change = await this.recordChange(manager, user, doctor.id, { availabilityId: null, kind, applyFrom: date, old, now }, affectedIds);
        changeId = change.id;
      }

      // Lifting an exception, or replacing the day with other hours, can bring waiting appointments back inside the hours.
      const widening = after === null || after.isAvailable || restoredIds.length > 0;
      const released = widening ? await this.release(manager, doctor.id, situation.clock) : { restored: 0, withdrawn: 0, more: false };
      return { changeId, date, affectedAppointments: affectedIds.length, patientsAsked: affectedIds.length, restoredAppointments: released.restored };
    });
    this.afterCommit(result, result.restoredAppointments > 0 || result.affectedAppointments === 0 ? doctorId : undefined);
    return result;
  }

  /** One tracking row per affected appointment, in one statement. */
  private async insertTracking(manager: EntityManager, changeId: string, appointmentIds: string[]): Promise<void> {
    await manager.query(
      `INSERT INTO schedule_change_appointments (change_id, appointment_id)
       SELECT $1, t.id FROM unnest($2::uuid[]) AS t(id)
       ON CONFLICT DO NOTHING`,
      [changeId, appointmentIds],
    );
  }

  /**
   * The one place a schedule change is written down: the audit row (who, what, from when, old and new hours) and one tracking row
   * per affected appointment. Every route that can affect appointments records through here.
   */
  private async recordChange(
    manager: EntityManager,
    user: AuthUser,
    doctorId: string,
    fields: { availabilityId: string | null; kind: 'EXPAND' | 'SHRINK' | 'MIXED'; applyFrom: string; old: { start: string; end: string }; now: { start: string; end: string } },
    affectedIds: string[],
  ): Promise<ScheduleChange> {
    const change = await manager.save(
      manager.create(ScheduleChange, {
        doctorId,
        availabilityId: fields.availabilityId,
        kind: fields.kind,
        applyFrom: fields.applyFrom,
        oldStartTime: fields.old.start,
        oldEndTime: fields.old.end,
        newStartTime: fields.now.start,
        newEndTime: fields.now.end,
        affectedCount: affectedIds.length,
        createdByUserId: user.id,
      }),
    );
    if (affectedIds.length > 0) await this.insertTracking(manager, change.id, affectedIds);
    return change;
  }

  /** Lets go of the appointments that were waiting for a new time and are inside the hours again, and queues their "valid again" messages. */
  async release(manager: EntityManager, doctorId: string, clock: { date: string; time: string }) {
    return reconcileCoverage(manager, doctorId, clock, undefined, (inner, ids) => this.notifications.appointmentsRestored(inner, ids));
  }

  /**
   * Routes that only ADD hours (a one-time session, new weekly rows) are checked here before anything is written: the whole change
   * is refused when it would bring an appointment inside the minimum-notice window back inside the hours. `afterRules` says what
   * the doctor's rules will be once the rows are written.
   */
  async assertAdditionAllowed(manager: EntityManager, doctor: Doctor, afterRules: (current: AvailabilityRule[]) => AvailabilityRule[]): Promise<void> {
    const situation = await this.situation(manager, doctor);
    const block = await this.windowBlock(manager, situation, { afterRules: afterRules(situation.rules), fromDate: situation.clock.date });
    if (block) throw tooClose(block);
  }

  /**
   * After the added rows are written: releases the appointments they bring back inside the hours and, when any were released,
   * records that as an extension (so the history shows it). Returns how many were released.
   */
  async settleAddition(
    manager: EntityManager,
    user: AuthUser,
    doctor: Doctor,
    added?: { availabilityId: string | null; applyFrom: string; start: string; end: string },
  ): Promise<number> {
    const released = await this.release(manager, doctor.id, clinicNow(this.config.clinicTimezone));
    if (released.restored > 0 && added) {
      // Written after the release in the same transaction, so its time equals the time the appointments were released (see history()).
      await this.recordChange(manager, user, doctor.id, { availabilityId: added.availabilityId, kind: 'EXPAND', applyFrom: added.applyFrom, old: { start: added.start, end: added.start }, now: { start: added.start, end: added.end } }, []);
    }
    return released.restored;
  }

  private async acknowledgeRequired(manager: EntityManager, affectedIds: string[]): Promise<ConflictException> {
    const shown = await this.withPatients(manager, affectedIds.slice(0, 20));
    const count = affectedIds.length;
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'ACKNOWLEDGE_REQUIRED',
      message:
        `${count} booked appointment${count === 1 ? '' : 's'} would fall outside your hours. ${count === 1 ? 'It stays' : 'They stay'} booked: nothing is moved or cancelled. ` +
        `${count === 1 ? 'The patient is' : 'Each patient is'} emailed and asked to choose a new time. Confirm to continue.`,
      affectedCount: count,
      appointments: shown.map(appointmentView),
    });
  }

  /**
   * Appointments the change would affect (or restore) that are inside the minimum-notice window: closer than the configured hours,
   * or already under way. Only the doctor's few appointments in that window are looked at, then the exact rules decide which are
   * really touched, so a change that affects nothing close is never blocked. `fromDate` ignores earlier dates (a change that starts later).
   */
  private async windowBlock(
    manager: EntityManager,
    situation: Situation,
    args: { afterRules: AvailabilityRule[]; afterOverrides?: (before: Map<string, DateOverride>) => Map<string, DateOverride>; fromDate?: string },
  ): Promise<WindowBlock | undefined> {
    const hours = this.config.scheduleChangeNoticeHours;
    if (hours <= 0) return undefined;
    const { clock } = situation;
    const limit = windowLimit(clock, hours);
    const rows = await manager
      .createQueryBuilder(Appointment, 'a')
      .select(['a.id', 'a.appointmentDate', 'a.startTime', 'a.endTime', 'a.slotNumber'])
      .where('a.doctorId = :doctorId', { doctorId: situation.doctor.id })
      .andWhere('a.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .andWhere(`NOT (a.status = 'PENDING' AND a.holdExpiresAt IS NOT NULL AND a.holdExpiresAt <= :now)`, { now: new Date() })
      .andWhere('a.appointmentDate >= :today AND (a.appointmentDate > :today OR a.endTime > :nowTime)', { today: clock.date, nowTime: clock.time })
      .andWhere('(a.appointmentDate, a.startTime) <= (:limitDate, :limitTime)', { limitDate: limit.date, limitTime: limit.time })
      .getMany();
    if (rows.length === 0) return undefined;
    const before = await this.overridesFor(manager, situation.doctor.id, clock.date, limit.date);
    const what = {
      appointments: rows.map(placed),
      rules: situation.rules,
      afterRules: args.afterRules,
      overrides: before,
      afterOverrides: args.afterOverrides ? args.afterOverrides(before) : before,
      fromDate: args.fromDate,
      doctor: situation.elastic,
    };
    const touched = new Set([...findAffected(what), ...findRestored(what)]);
    if (touched.size === 0) return undefined;
    const withNames = await this.withPatients(manager, [...touched]);
    return describeBlock(
      withNames.map((a) => ({ id: a.id, date: a.appointmentDate, startTime: hhmm(a.startTime), endTime: hhmm(a.endTime), patientName: a.patient.user.name })),
      hours,
      clock,
    );
  }

  // ---- internals ----

  private async requireDoctor(manager: EntityManager, user: AuthUser, lock = false): Promise<Doctor> {
    const doctor = await manager.findOne(Doctor, { where: { userId: user.id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!doctor) throw new ForbiddenException('No doctor profile is linked to this account.');
    return doctor;
  }

  private async overridesFor(manager: EntityManager, doctorId: string, from: string, to: string): Promise<Map<string, DateOverride>> {
    const rows = await manager.find(ScheduleOverride, { where: { doctorId, overrideDate: Between(from, to) } });
    return new Map(rows.map((row) => [row.overrideDate, toOverride(row)]));
  }

  /** The doctor's rules as of now, and the dates that can hold appointments. */
  private async situation(manager: EntityManager, doctor: Doctor): Promise<Situation> {
    const clock = clinicNow(this.config.clinicTimezone);
    const rules = (await manager.findBy(Availability, { doctorId: doctor.id })).map(toRule);
    return {
      doctor,
      elastic: { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultDailyCapacity, slotIntervalMinutes: slotIntervalOf(doctor) },
      clock,
      lastDate: addDays(clock.date, this.config.bookingWindowDays),
      rules,
    };
  }

  /** Appointments still holding a slot and not yet started. An unpaid hold whose time has run out no longer holds its slot. */
  private liveUpcoming(manager: EntityManager, doctorId: string, clock: { date: string; time: string }) {
    return manager
      .createQueryBuilder(Appointment, 'a')
      .where('a.doctorId = :doctorId', { doctorId })
      .andWhere('a.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .andWhere(`NOT (a.status = 'PENDING' AND a.holdExpiresAt IS NOT NULL AND a.holdExpiresAt <= :now)`, { now: new Date() })
      .andWhere('(a.appointmentDate > :today OR (a.appointmentDate = :today AND a.startTime > :nowTime))', { today: clock.date, nowTime: clock.time });
  }

  /** Loads these appointments with their patients, in the order they were found. */
  private async withPatients(manager: EntityManager, ids: string[]): Promise<Appointment[]> {
    const rows = await manager.find(Appointment, { where: { id: In(ids) }, relations: { patient: { user: true } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)).filter((row): row is Appointment => row !== undefined);
  }

  /**
   * Pages through the doctor's upcoming appointments in date order, a few hundred at a time, keeping those outside the hours as
   * they are now. Memory stays at one chunk however many appointments there are, and a page stops as soon as it is full.
   */
  private async scanOutside(manager: EntityManager, situation: Situation, cursor: string | undefined, limit: number): Promise<{ found: { id: string; key: string }[]; next: string | null }> {
    const found: { id: string; key: string }[] = [];
    let after = cursor ? parseCursor(cursor) : null;
    for (;;) {
      const query = this.liveUpcoming(manager, situation.doctor.id, situation.clock)
        .select(['a.id', 'a.appointmentDate', 'a.startTime', 'a.endTime', 'a.slotNumber'])
        .orderBy('a.appointmentDate', 'ASC')
        .addOrderBy('a.startTime', 'ASC')
        .addOrderBy('a.slotNumber', 'ASC')
        .addOrderBy('a.id', 'ASC')
        .limit(SCAN_CHUNK);
      if (after) query.andWhere('(a.appointmentDate, a.startTime, a.slotNumber, a.id) > (:d, :s, :n, :i)', { d: after.date, s: after.start, n: after.seat, i: after.id });
      const chunk = await query.getMany();
      if (chunk.length === 0) return { found, next: null };
      const outside = await appointmentsOutsideHours(manager, situation.doctor.id, chunk.map(placed));
      for (const row of chunk) {
        if (!outside.has(row.id)) continue;
        if (found.length === limit) return { found, next: found[found.length - 1].key };
        found.push({ id: row.id, key: cursorOf(row) });
      }
      const last = chunk[chunk.length - 1];
      after = { date: last.appointmentDate, start: last.startTime, seat: last.slotNumber, id: last.id };
      if (chunk.length < SCAN_CHUNK) return { found, next: null };
    }
  }

  /** Up to a few open times for each target, nearest first, under these rules. */
  private alternatives(targets: Appointment[], situation: Situation, rules: AvailabilityRule[], overrides: Map<string, DateOverride>, bookedOn: BookedOn): Promise<Map<string, OpenSlot[]>> {
    return openTimes({
      targets: targets.map((target) => ({ id: target.id, date: target.appointmentDate, startTime: target.startTime })),
      rules,
      overrides,
      elastic: situation.elastic,
      clock: situation.clock,
      lastDate: situation.lastDate,
      bookedOn,
      limit: ALTERNATIVES,
    });
  }

  private async plan(manager: EntityManager, user: AuthUser, id: string, input: ChangeInput, options: { lock?: boolean } = {}) {
    const doctor = await this.requireDoctor(manager, user, options.lock);
    const row = await manager.findOneBy(Availability, { id, doctorId: doctor.id });
    if (!row) throw new NotFoundException('Availability not found.');

    const today = clinicNow(this.config.clinicTimezone).date;
    let applyFrom = input.applyFrom ?? today;
    if (row.recurrenceType === 'ONE_TIME') {
      // A single date changes only that date.
      if (!row.specificDate || row.specificDate < today) throw new ConflictException('That date has already passed, so its hours can no longer be changed.');
      applyFrom = row.specificDate;
    } else {
      if (!isValidDate(applyFrom)) throw new BadRequestException('applyFrom must be a valid YYYY-MM-DD date.');
      if (applyFrom < today) throw new BadRequestException('Changes apply from today onwards; earlier dates keep their hours.');
      if (row.effectiveTo !== null && row.effectiveTo < applyFrom) throw new ConflictException('This session has already ended, so its hours can no longer be changed.');
    }
    const split = row.recurrenceType === 'WEEKLY' && !(row.effectiveFrom !== null && row.effectiveFrom >= applyFrom);

    // Patients can book only this far ahead, so these are the dates that exist today. Later dates take the new hours when they open up.
    const situation = await this.situation(manager, doctor);
    const overrides = await this.overridesFor(manager, doctor.id, applyFrom, situation.lastDate);
    const proposed = { startTime: input.startTime, endTime: input.endTime };
    const plan = planChange({ row: toRule(row), proposed, rules: situation.rules, overrides, doctor: situation.elastic, applyFrom, lastDate: situation.lastDate });

    // Reducing hours: which booked appointments would be left outside them. The database narrows the field to appointments inside
    // this row's old window that stick out of the new one, on the days it applies; the exact rules then decide each of those.
    const afterRules = situation.rules.map((rule) => (rule.id === row.id ? { ...rule, ...proposed } : rule));
    let affected: Appointment[] = [];
    let affectedIds: string[] = [];
    let restored: Appointment[] = [];
    let restoredCount = 0;
    let restriction: WindowBlock | undefined;
    if (plan.problems.length === 0 && plan.kind !== 'NONE') {
      if (plan.kind === 'SHRINK' || plan.kind === 'MIXED') {
        const candidates = await this.candidates(manager, row, proposed, applyFrom, situation);
        const exact = new Set(findAffected({ appointments: candidates.map(placed), rules: situation.rules, afterRules, overrides, doctor: situation.elastic }));
        // Everything that is affected is recorded when applied, not only the listed page.
        affectedIds = candidates.filter((candidate) => exact.has(candidate.id)).map((candidate) => candidate.id);
        affected = await this.withPatients(manager, affectedIds.slice(0, PREVIEW_APPOINTMENTS));
      }
      // Extending: booked appointments that are outside the hours now and would be inside them again.
      if (plan.kind === 'EXPAND' || plan.kind === 'MIXED') {
        const candidates = await this.candidates(manager, row, proposed, applyFrom, situation, 'RESTORED');
        const exact = new Set(findRestored({ appointments: candidates.map(placed), rules: situation.rules, afterRules, overrides, doctor: situation.elastic }));
        const ids = candidates.filter((candidate) => exact.has(candidate.id)).map((candidate) => candidate.id);
        restoredCount = ids.length;
        restored = await this.withPatients(manager, ids.slice(0, PREVIEW_APPOINTMENTS));
      }
      // The minimum-notice rule: a change that would touch an appointment that is close or under way is refused (preview and apply alike).
      restriction = await this.windowBlock(manager, situation, { afterRules, fromDate: applyFrom });
    }
    return { doctor, row, applyFrom, split, plan, proposed, affected, affectedIds, affectedCount: affectedIds.length, restored, restoredCount, restriction, situation, overrides, afterRules };
  }

  /**
   * Appointments a change of this row could affect, narrowed by the database before the exact rules decide each one, on the row's
   * days. 'AFFECTED' (shrinking): inside the old window and sticking out of the new one. 'RESTORED' (extending): inside the new
   * window but not entirely inside the old one.
   */
  private async candidates(manager: EntityManager, row: Availability, proposed: Window, applyFrom: string, situation: Situation, mode: 'AFFECTED' | 'RESTORED' = 'AFFECTED'): Promise<Appointment[]> {
    const from = row.effectiveFrom !== null && row.effectiveFrom > applyFrom ? row.effectiveFrom : applyFrom;
    const to = row.effectiveTo !== null && row.effectiveTo < situation.lastDate ? row.effectiveTo : situation.lastDate;
    if (from > to) return [];
    const query = this.liveUpcoming(manager, situation.doctor.id, situation.clock)
      .select(['a.id', 'a.appointmentDate', 'a.startTime', 'a.endTime', 'a.slotNumber'])
      .andWhere('a.appointmentDate BETWEEN :from AND :to', { from, to })
      .orderBy('a.appointmentDate', 'ASC')
      .addOrderBy('a.startTime', 'ASC')
      .addOrderBy('a.slotNumber', 'ASC')
      .addOrderBy('a.id', 'ASC');
    const old = { oldStart: hhmm(row.startTime), oldEnd: hhmm(row.endTime) };
    const next = { newStart: hhmm(proposed.startTime), newEnd: hhmm(proposed.endTime) };
    if (mode === 'AFFECTED') {
      query.andWhere('a.startTime >= :oldStart AND a.endTime <= :oldEnd', old).andWhere('(a.startTime < :newStart OR a.endTime > :newEnd)', next);
    } else {
      query.andWhere('a.startTime >= :newStart AND a.endTime <= :newEnd', next).andWhere('NOT (a.startTime >= :oldStart AND a.endTime <= :oldEnd)', old);
    }
    if (row.recurrenceType === 'ONE_TIME') query.andWhere('a.appointmentDate = :only', { only: row.specificDate });
    else query.andWhere('EXTRACT(DOW FROM a.appointment_date) = :dow', { dow: row.dayOfWeek });
    return query.getMany();
  }

  private async describe(manager: EntityManager, planned: Awaited<ReturnType<AvailabilityChangeService['plan']>>) {
    const { row, applyFrom, split, plan, proposed, affected, affectedCount, restored, restoredCount, situation, overrides, afterRules } = planned;
    const problems = [...plan.problems];
    if (plan.kind === 'NONE') problems.push('These are already the hours.');
    if (planned.restriction) problems.push(planned.restriction.message);
    const alternatives = await this.alternatives(affected, situation, afterRules, overrides, bookedLoader(manager, situation.doctor.id, situation.lastDate));
    const affectedAppointments = affected.map((appointment) => ({ ...appointmentView(appointment), alternatives: alternatives.get(appointment.id) ?? [] }));
    return {
      row: {
        id: row.id,
        recurrence: row.recurrenceType,
        dayOfWeek: row.dayOfWeek,
        date: row.specificDate,
        mode: row.schedulingMode,
        slotMinutes: row.slotDurationMinutes,
        capacityPerSlot: row.capacityPerSlot,
      },
      current: { startTime: hhmm(row.startTime), endTime: hhmm(row.endTime) },
      proposed: { startTime: hhmm(proposed.startTime), endTime: hhmm(proposed.endTime) },
      applyFrom,
      /** True when earlier dates of a recurring session keep their hours and a new row takes over from `applyFrom`. */
      splitsAtDate: split,
      kind: plan.kind,
      problems,
      suggestedStarts: plan.suggestedStarts,
      addedSlots: plan.addedSlots,
      removedSlots: plan.removedSlots,
      affectedDates: plan.days.length,
      days: plan.days.slice(0, PREVIEW_DAYS),
      /** The first booked appointments the new hours would leave outside them. They stay booked; each patient is asked to choose a new time. */
      affectedAppointments,
      /** How many in all (the list above shows the first few). */
      affectedCount,
      /** Appointments waiting for a new time that this extension brings back inside the hours (the first few). They need nothing more. */
      restoredAppointments: restored.map(appointmentView),
      /** How many in all. */
      restoredCount,
      /** How many of the listed ones have no other open time to move to. */
      withoutAlternatives: affectedAppointments.filter((appointment) => appointment.alternatives.length === 0).length,
      /** Set when the change is refused because it affects an appointment inside the minimum-notice window (see SCHEDULE_CHANGE_MIN_NOTICE_HOURS). */
      restriction: planned.restriction ? restrictionView(planned.restriction) : null,
      canApply: problems.length === 0,
    };
  }
}

/** What a request to change an exception says (the validated shape the controller passes on). */
export interface OverrideInput {
  date: string;
  isAvailable: boolean;
  startTime?: string;
  endTime?: string;
  capacity?: number;
  reason?: string;
}

/** A row that is about to be written, as the pure scheduling rules see it (for asking "what would the schedule be then?"). */
export function pendingRule(
  row: Pick<AvailabilityRule, 'recurrenceType' | 'dayOfWeek' | 'specificDate' | 'startTime' | 'endTime' | 'capacity' | 'schedulingMode' | 'slotDurationMinutes' | 'capacityPerSlot' | 'effectiveFrom' | 'effectiveTo'>,
  id: string,
): AvailabilityRule {
  return {
    id,
    recurrenceType: row.recurrenceType,
    dayOfWeek: row.dayOfWeek,
    specificDate: row.specificDate,
    startTime: row.startTime,
    endTime: row.endTime,
    capacity: row.capacity,
    schedulingMode: row.schedulingMode,
    slotDurationMinutes: row.slotDurationMinutes,
    capacityPerSlot: row.capacityPerSlot,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const restrictionView = (block: WindowBlock) => ({
  hours: block.hours,
  message: block.message,
  earliest: block.earliest,
  allowedFrom: block.allowedFrom,
  blockedCount: block.blocked.length,
  blocked: block.blocked.slice(0, 20),
});

/** The change is refused whole (nothing was written) because it would affect an appointment that is too close or under way. */
const tooClose = (block: WindowBlock) => new ConflictException({ statusCode: 409, error: 'Conflict', code: 'CHANGE_TOO_CLOSE', message: block.message, restriction: restrictionView(block) });

/** The most patients in any one slot of these bookings, and how many slots hold more than perSlot (counted with the slot engine's own placesTaken). */
export function slotLoad(live: Appointment[], perSlot: number): { maxBooked: number; overCapacity: { slots: number; maxBooked: number } | null } {
  const byDate = new Map<string, Appointment[]>();
  for (const a of live) byDate.set(a.appointmentDate, [...(byDate.get(a.appointmentDate) ?? []), a]);
  let maxBooked = 0;
  let overSlots = 0;
  let overMax = 0;
  for (const list of byDate.values()) {
    const windows = list.map((a) => ({ start: toMinutes(hhmm(a.startTime)), end: toMinutes(hhmm(a.endTime)) }));
    const seen = new Set<string>();
    for (const a of list) {
      const key = `${hhmm(a.startTime)}-${hhmm(a.endTime)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const taken = placesTaken(windows, toMinutes(hhmm(a.startTime)), toMinutes(hhmm(a.endTime)));
      maxBooked = Math.max(maxBooked, taken);
      if (taken > perSlot) {
        overSlots++;
        overMax = Math.max(overMax, taken);
      }
    }
  }
  return { maxBooked, overCapacity: overSlots > 0 ? { slots: overSlots, maxBooked: overMax } : null };
}

const capacityBelowBookings = (message: string) => new ConflictException({ statusCode: 409, error: 'Conflict', code: 'CAPACITY_BELOW_BOOKINGS', message });

const useAdjustHours = (reason: string) =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'USE_ADJUST_HOURS',
    message: `${reason} Use Adjust hours on that session instead: it keeps the bookings, shows who is affected, and asks each patient to choose a new time.`,
  });

const placed = (appointment: Appointment): Placed => ({ id: appointment.id, date: appointment.appointmentDate, startTime: appointment.startTime, endTime: appointment.endTime });

const cursorOf = (appointment: Appointment) => Buffer.from(`${appointment.appointmentDate}|${appointment.startTime}|${appointment.slotNumber}|${appointment.id}`).toString('base64url');

function parseCursor(cursor: string): { date: string; start: string; seat: number; id: string } {
  const [date, start, seat, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!date || !isValidDate(date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(start ?? '') || !Number.isInteger(Number(seat)) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) throw new BadRequestException('That page cursor is not valid.');
  return { date, start, seat: Number(seat), id };
}

function appointmentView(appointment: Appointment) {
  return {
    id: appointment.id,
    date: appointment.appointmentDate,
    startTime: hhmm(appointment.startTime),
    endTime: hhmm(appointment.endTime),
    status: appointment.status,
    slotNumber: appointment.slotNumber,
    patient: { name: appointment.patient.user.name, phone: appointment.patient.phone },
  };
}

/** Where one unresolved patient stands. No time open outranks everything (the doctor must act); then never asked; then asked and silent after every reminder; else waiting. */
export function followUpState(input: { alternatives: number; asked: boolean; reminders: number; lastContact: Date | null; cutoff: Date }) {
  const state =
    input.alternatives === 0
      ? 'NO_ALTERNATIVES'
      : !input.asked
        ? 'NOT_ASKED'
        : input.reminders >= MAX_NEW_TIME_REMINDERS && input.lastContact !== null && input.lastContact <= input.cutoff
          ? 'NO_RESPONSE'
          : 'WAITING';
  return { state, reminders: input.reminders, lastContactAt: input.lastContact && input.lastContact.getTime() > 0 ? input.lastContact : null };
}

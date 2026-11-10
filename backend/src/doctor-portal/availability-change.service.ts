import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, In, MoreThanOrEqual, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { ACTIVE_STATUSES, Appointment, Availability, Doctor, Notification, ScheduleChange, ScheduleOverride, slotIntervalOf } from '../database/entities/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { addDays, clinicNow, isValidDate } from '../scheduling/calendar.js';
import { toRule } from '../scheduling/day-schedule.js';
import { findAffected, findRestored, planChange, type ElasticDoctor, type OpenSlot, type Placed, type Window } from '../scheduling/elastic.js';
import type { AvailabilityRule } from '../scheduling/availability-rules.js';
import { appointmentsOutsideHours, toOverride } from '../scheduling/outside-hours.js';
import { reconcileCoverage } from '../scheduling/schedule-reconciler.js';
import { rescheduleLink, ScheduleChangeNotifier } from '../scheduling/schedule-change-notifier.service.js';
import { bookedLoader, openTimes, type BookedOn } from '../scheduling/open-times.js';
import { hhmm, type DateOverride } from '../scheduling/slots.js';

export interface ChangeInput {
  startTime: string;
  endTime: string;
  /** Recurring sessions only: the first date the new hours apply to. Earlier dates keep their hours. Defaults to today. */
  applyFrom?: string;
}

export interface Proposal {
  appointmentId: string;
  date: string;
  startTime: string;
}

export interface ApplyChangeInput extends ChangeInput {
  /** The hours the doctor previewed against. If the session has changed since, the change is refused rather than applied blindly. */
  from: Window;
  /** Required when reducing the hours would leave booked appointments outside them: the doctor has seen the list and agrees. */
  acknowledge?: boolean;
  /** Optional suggested new times for affected appointments, chosen from the alternatives the preview offered. */
  proposals?: Proposal[];
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
interface Situation {
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
    const result = await this.dataSource.transaction(async (manager) => {
      const planned = await this.plan(manager, user, id, input, { lock: true });
      const now = { startTime: hhmm(planned.row.startTime), endTime: hhmm(planned.row.endTime) };
      if (now.startTime !== input.from.startTime || now.endTime !== input.from.endTime) {
        throw new ConflictException('This session changed since you previewed it. Preview the change again.');
      }
      const view = await this.describe(manager, planned);
      if (!view.canApply) throw new BadRequestException(view.problems.join(' ') || 'Nothing to change.');
      if (view.affectedCount > 0 && !input.acknowledge) {
        throw new ConflictException(
          `${view.affectedCount} booked appointment${view.affectedCount === 1 ? '' : 's'} would fall outside the new hours. Review ${view.affectedCount === 1 ? 'it' : 'them'} and confirm that you understand ${view.affectedCount === 1 ? 'it stays' : 'they stay'} booked until the patient chooses a new time.`,
        );
      }
      const chosen = this.checkProposals(view.affectedAppointments, input.proposals ?? []);

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
      const change = await manager.save(
        manager.create(ScheduleChange, {
          doctorId: planned.doctor.id,
          availabilityId: resultId,
          kind: view.kind === 'NONE' ? 'SHRINK' : view.kind,
          applyFrom,
          oldStartTime: now.startTime,
          oldEndTime: now.endTime,
          newStartTime: hhmm(input.startTime),
          newEndTime: hhmm(input.endTime),
          affectedCount: view.affectedCount,
          createdByUserId: user.id,
        }),
      );
      if (planned.affectedIds.length > 0) {
        const ids = planned.affectedIds;
        const suggestion = (id: string) => chosen.get(id);
        await manager.query(
          `INSERT INTO schedule_change_appointments (change_id, appointment_id, proposed_date, proposed_start_time, proposed_end_time)
           SELECT $1, t.id, t.d, t.s, t.e FROM unnest($2::uuid[], $3::date[], $4::time[], $5::time[]) AS t(id, d, s, e)
           ON CONFLICT DO NOTHING`,
          [change.id, ids, ids.map((id) => suggestion(id)?.date ?? null), ids.map((id) => suggestion(id)?.startTime ?? null), ids.map((id) => suggestion(id)?.endTime ?? null)],
        );
      }
      // Extending (or the extending side of a mixed change): appointments that were waiting for a new time and are inside the hours
      // again are released here, in the same transaction, so nobody ever sees the new hours with the old bookkeeping.
      const widened = view.kind === 'EXPAND' || view.kind === 'MIXED';
      const released = widened ? await reconcileCoverage(manager, planned.doctor.id, planned.situation.clock) : { restored: 0, withdrawn: 0, more: false };
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
    }
    return {
      appointments: targets.map((appointment) => ({
        ...appointmentView(appointment),
        alternatives: alternatives.get(appointment.id) ?? [],
        asked: asked.get(appointment.id) ?? null,
        /** True while the notice is queued but not yet handed to the outbox by the background job. */
        noticePending: waiting.has(appointment.id),
      })),
      nextCursor: next,
    };
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

  /** Asks the patient again (at most once a day) to choose a new time, optionally suggesting one of the open times. */
  async askNewTime(user: AuthUser, appointmentId: string, proposal?: { date: string; startTime: string }) {
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
      const overrides = await this.overridesFor(manager, doctor.id, situation.clock.date, situation.lastDate);
      const options = (await this.alternatives([appointment], situation, situation.rules, overrides, bookedLoader(manager, doctor.id, situation.lastDate))).get(appointment.id) ?? [];
      const chosen = proposal ? options.find((option) => option.date === proposal.date && option.startTime === proposal.startTime) : undefined;
      if (proposal && !chosen) throw new ConflictException('That suggested time is no longer open. Choose another.');
      // At most one request a day per patient, counting the one sent when the hours changed.
      const recent = await manager.findOne(Notification, {
        where: { appointmentId: appointment.id, kind: 'needs-new-time', channel: 'email', status: In(['PENDING', 'SENT']), createdAt: MoreThanOrEqual(new Date(Date.now() - 24 * 3_600_000)) },
        order: { createdAt: 'DESC' },
      });
      if (recent) throw new ConflictException('You have already asked this patient in the last 24 hours. Their email may still be on its way.');
      const changeKey = `ask-${situation.clock.date}`;
      await this.notifications.appointmentNeedsNewTime(manager, appointment.id, {
        link: rescheduleLink(this.config.frontendUrl, doctor.id, appointment.id, chosen?.date),
        changeKey,
        proposed: chosen && { date: chosen.date, startTime: chosen.startTime, endTime: chosen.endTime },
      });
      return true;
    });
    if (asked) this.notifications.kick();
    return { asked };
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

  /** Each suggested time must be one of the open times offered for that appointment, so a stale or invented suggestion is refused. */
  private checkProposals(affected: { id: string; alternatives: OpenSlot[] }[], proposals: Proposal[]): Map<string, OpenSlot> {
    const chosen = new Map<string, OpenSlot>();
    for (const proposal of proposals) {
      const target = affected.find((appointment) => appointment.id === proposal.appointmentId);
      const slot = target?.alternatives.find((option) => option.date === proposal.date && option.startTime === proposal.startTime);
      if (!slot) throw new ConflictException('A suggested time is no longer open, or is not for an affected appointment. Preview the change again.');
      chosen.set(proposal.appointmentId, slot);
    }
    return chosen;
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
    let affectedCount = 0;
    if (plan.problems.length === 0 && (plan.kind === 'SHRINK' || plan.kind === 'MIXED')) {
      const candidates = await this.candidates(manager, row, proposed, applyFrom, situation);
      const exact = new Set(findAffected({ appointments: candidates.map(placed), rules: situation.rules, afterRules, overrides, doctor: situation.elastic }));
      const ids = candidates.filter((candidate) => exact.has(candidate.id)).map((candidate) => candidate.id);
      affectedCount = ids.length;
      affected = await this.withPatients(manager, ids.slice(0, PREVIEW_APPOINTMENTS));
      // Everything that is affected is recorded when applied, not only the listed page.
      return { doctor, row, applyFrom, split, plan, proposed, affected, affectedIds: ids, affectedCount, restored: [] as Appointment[], restoredCount: 0, situation, overrides, afterRules };
    }
    // Extending: booked appointments that are outside the hours now and would be inside them again.
    let restored: Appointment[] = [];
    let restoredCount = 0;
    if (plan.problems.length === 0 && (plan.kind === 'EXPAND' || plan.kind === 'MIXED')) {
      const candidates = await this.candidates(manager, row, proposed, applyFrom, situation, 'RESTORED');
      const exact = new Set(findRestored({ appointments: candidates.map(placed), rules: situation.rules, afterRules, overrides, doctor: situation.elastic }));
      const ids = candidates.filter((candidate) => exact.has(candidate.id)).map((candidate) => candidate.id);
      restoredCount = ids.length;
      restored = await this.withPatients(manager, ids.slice(0, PREVIEW_APPOINTMENTS));
    }
    return { doctor, row, applyFrom, split, plan, proposed, affected, affectedIds: [] as string[], affectedCount, restored, restoredCount, situation, overrides, afterRules };
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
      canApply: problems.length === 0,
    };
  }
}

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

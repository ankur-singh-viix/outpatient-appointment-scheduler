import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, In, MoreThanOrEqual, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { ACTIVE_STATUSES, Appointment, Availability, Doctor, Notification, ScheduleOverride, slotIntervalOf } from '../database/entities/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { addDays, clinicNow, isValidDate } from '../scheduling/calendar.js';
import { toRule } from '../scheduling/day-schedule.js';
import { findAffected, openSlotsOn, planChange, type ChangePlan, type ElasticDoctor, type OpenSlot, type Placed, type Window } from '../scheduling/elastic.js';
import type { AvailabilityRule } from '../scheduling/availability-rules.js';
import { appointmentsOutsideHours, toOverride } from '../scheduling/outside-hours.js';
import { hhmm, type BookedWindow, type DateOverride } from '../scheduling/slots.js';

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
/** How many alternative times are offered for each affected appointment. */
const ALTERNATIVES = 5;

/** The context a plan or a list needs about one doctor right now. */
interface Situation {
  doctor: Doctor;
  elastic: ElasticDoctor;
  clock: { date: string; time: string };
  lastDate: string;
  rules: AvailabilityRule[];
  /** Active appointments that are still holding a slot (an expired payment hold is not), over the dates in range. */
  live: Appointment[];
}

/**
 * Changing the hours of an availability row after patients have booked it ("elastic scheduling"). A change is previewed first,
 * from the same engine patients are offered slots from; applying it re-checks everything inside a transaction that holds the
 * doctor row lock bookings take, so a booking in flight either finishes first (and is counted) or waits and sees the new hours.
 *
 * Appointments are never moved, changed or cancelled here. Extending hours only adds slots. Reducing hours stops new bookings in
 * the removed time at once, leaves every existing appointment booked, and asks each affected patient to choose a new time through
 * the normal reschedule flow, which is their confirmation. Cancelling remains the doctor's own last resort, with its reason, notice
 * and refund, through the existing cancel action.
 */
@Injectable()
export class AvailabilityChangeService {
  private readonly config = loadConfig();

  constructor(
    @InjectRepository(Doctor) private readonly doctors: Repository<Doctor>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /** What a change would do, without doing anything. */
  async preview(user: AuthUser, id: string, input: ChangeInput) {
    return this.describe(await this.plan(this.dataSource.manager, user, id, input));
  }

  /** Makes the change, and asks the patients of any appointment it leaves outside the hours. Returns what it did. */
  async apply(user: AuthUser, id: string, input: ApplyChangeInput) {
    const result = await this.dataSource.transaction(async (manager) => {
      const planned = await this.plan(manager, user, id, input, { lock: true });
      const now = { startTime: hhmm(planned.row.startTime), endTime: hhmm(planned.row.endTime) };
      if (now.startTime !== input.from.startTime || now.endTime !== input.from.endTime) {
        throw new ConflictException('This session changed since you previewed it. Preview the change again.');
      }
      const view = this.describe(planned);
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

      // Ask each affected patient to choose a new time. Their appointment is not touched: it moves only if they confirm.
      const changeKey = `${hhmm(input.startTime)}-${hhmm(input.endTime)}-${applyFrom}`;
      for (const appointment of view.affectedAppointments) {
        await this.notifications.appointmentNeedsNewTime(manager, appointment.id, {
          link: this.rescheduleLink(planned.doctor.id, appointment.id, chosen.get(appointment.id)?.date),
          changeKey,
          proposed: chosen.get(appointment.id) && { date: chosen.get(appointment.id)!.date, startTime: chosen.get(appointment.id)!.startTime, endTime: chosen.get(appointment.id)!.endTime },
        });
      }
      return { id: resultId, kind: view.kind, split, applyFrom, addedSlots: view.addedSlots, removedSlots: view.removedSlots, affectedAppointments: view.affectedCount, patientsAsked: view.affectedCount };
    });
    if (result.patientsAsked > 0) this.notifications.kick();
    return result;
  }

  /**
   * Booked appointments that are outside the doctor's hours as they are right now (after reducing hours, or taking a day off),
   * with times that are still open, and whether the patient has been asked to choose a new one.
   */
  async outsideHours(user: AuthUser) {
    const manager = this.dataSource.manager;
    const doctor = await this.requireDoctor(manager, user);
    const situation = await this.situation(manager, doctor, clinicNow(this.config.clinicTimezone).date);
    const upcoming = this.upcoming(situation.live, situation.clock);
    const outside = await appointmentsOutsideHours(manager, doctor.id, upcoming.map(placed));
    const targets = upcoming.filter((appointment) => outside.has(appointment.id));
    const overrides = await this.overridesFor(manager, doctor.id, situation.clock.date, situation.lastDate);
    const alternatives = this.alternatives(targets, situation, situation.rules, overrides);

    const asked = new Map<string, { at: Date; status: string }>();
    if (targets.length > 0) {
      const requests = await manager.find(Notification, { where: { appointmentId: In(targets.map((target) => target.id)), kind: 'needs-new-time', channel: 'email' }, order: { createdAt: 'ASC' } });
      for (const request of requests) if (request.appointmentId) asked.set(request.appointmentId, { at: request.createdAt, status: request.status });
    }
    return {
      appointments: targets.map((appointment) => ({
        ...appointmentView(appointment),
        alternatives: alternatives.get(appointment.id) ?? [],
        asked: asked.get(appointment.id) ?? null,
      })),
    };
  }

  /** Asks the patient again (at most once a day) to choose a new time, optionally suggesting one of the open times. */
  async askNewTime(user: AuthUser, appointmentId: string, proposal?: { date: string; startTime: string }) {
    const asked = await this.dataSource.transaction(async (manager) => {
      const doctor = await this.requireDoctor(manager, user, true);
      const appointment = await manager.findOne(Appointment, { where: { id: appointmentId, doctorId: doctor.id }, relations: { patient: { user: true } } });
      if (!appointment) throw new NotFoundException('Appointment not found.');
      const situation = await this.situation(manager, doctor, clinicNow(this.config.clinicTimezone).date);
      const upcoming = this.upcoming(situation.live, situation.clock).filter((entry) => entry.id === appointment.id);
      if (upcoming.length === 0) throw new ConflictException('This appointment is not active or has already started.');
      if ((await appointmentsOutsideHours(manager, doctor.id, upcoming.map(placed))).size === 0) {
        throw new ConflictException('This appointment is within your hours, so there is nothing to ask the patient.');
      }
      const overrides = await this.overridesFor(manager, doctor.id, situation.clock.date, situation.lastDate);
      const options = this.alternatives(upcoming, situation, situation.rules, overrides).get(appointment.id) ?? [];
      const chosen = proposal ? options.find((option) => option.date === proposal.date && option.startTime === proposal.startTime) : undefined;
      if (proposal && !chosen) throw new ConflictException('That suggested time is no longer open. Choose another.');
      // At most one request a day per patient, counting the one sent when the hours changed.
      const recent = await manager.findOne(Notification, {
        where: { appointmentId: appointment.id, kind: 'needs-new-time', channel: 'email', createdAt: MoreThanOrEqual(new Date(Date.now() - 24 * 3_600_000)) },
        order: { createdAt: 'DESC' },
      });
      if (recent) throw new ConflictException('You have already asked this patient in the last 24 hours. Their email may still be on its way.');
      const changeKey = `ask-${situation.clock.date}`;
      await this.notifications.appointmentNeedsNewTime(manager, appointment.id, {
        link: this.rescheduleLink(doctor.id, appointment.id, chosen?.date),
        changeKey,
        proposed: chosen && { date: chosen.date, startTime: chosen.startTime, endTime: chosen.endTime },
      });
      return true;
    });
    if (asked) this.notifications.kick();
    return { asked };
  }

  // ---- internals ----

  private rescheduleLink(doctorId: string, appointmentId: string, date?: string): string {
    return `${this.config.frontendUrl}/doctors/${doctorId}?reschedule=${appointmentId}${date ? `&date=${date}` : ''}`;
  }

  private async requireDoctor(manager: EntityManager, user: AuthUser, lock = false): Promise<Doctor> {
    const doctor = await manager.findOne(Doctor, { where: { userId: user.id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!doctor) throw new ForbiddenException('No doctor profile is linked to this account.');
    return doctor;
  }

  private async overridesFor(manager: EntityManager, doctorId: string, from: string, to: string): Promise<Map<string, DateOverride>> {
    const rows = await manager.find(ScheduleOverride, { where: { doctorId, overrideDate: Between(from, to) } });
    return new Map(rows.map((row) => [row.overrideDate, toOverride(row)]));
  }

  /** The doctor's rules and active appointments as of now, over the dates that can hold appointments. */
  private async situation(manager: EntityManager, doctor: Doctor, from: string): Promise<Situation> {
    const now = new Date();
    const clock = clinicNow(this.config.clinicTimezone, now);
    const lastDate = addDays(clock.date, this.config.bookingWindowDays);
    const rules = (await manager.findBy(Availability, { doctorId: doctor.id })).map(toRule);
    const active = await manager.find(Appointment, {
      where: { doctorId: doctor.id, appointmentDate: from > clock.date ? Between(from, lastDate) : MoreThanOrEqual(clock.date), status: In(ACTIVE_STATUSES) },
      relations: { patient: { user: true } },
      order: { appointmentDate: 'ASC', startTime: 'ASC', slotNumber: 'ASC' },
    });
    // An unpaid hold whose time has run out no longer holds its slot.
    const live = active.filter((appointment) => !(appointment.status === 'PENDING' && appointment.holdExpiresAt !== null && appointment.holdExpiresAt.getTime() <= now.getTime()));
    return {
      doctor,
      elastic: { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultDailyCapacity, slotIntervalMinutes: slotIntervalOf(doctor) },
      clock,
      lastDate,
      rules,
      live,
    };
  }

  /** Appointments that have not started yet. */
  private upcoming(live: Appointment[], clock: { date: string; time: string }): Appointment[] {
    return live.filter((appointment) => appointment.appointmentDate > clock.date || (appointment.appointmentDate === clock.date && hhmm(appointment.startTime) > clock.time));
  }

  /** Up to a few open times for each target, nearest first: the same day, then the following days, under these rules. */
  private alternatives(targets: Appointment[], situation: Situation, rules: AvailabilityRule[], overrides: Map<string, DateOverride>): Map<string, OpenSlot[]> {
    const booked = new Map<string, BookedWindow[]>();
    for (const appointment of situation.live) {
      booked.set(appointment.appointmentDate, [...(booked.get(appointment.appointmentDate) ?? []), { startTime: hhmm(appointment.startTime), endTime: hhmm(appointment.endTime), slotNumber: appointment.slotNumber }]);
    }
    const open = new Map<string, OpenSlot[]>();
    const openOn = (date: string) => {
      let slots = open.get(date);
      if (!slots) {
        slots = openSlotsOn(date, rules, overrides.get(date) ?? null, situation.elastic, booked.get(date) ?? [], date === situation.clock.date ? situation.clock.time : null);
        open.set(date, slots);
      }
      return slots;
    };
    const result = new Map<string, OpenSlot[]>();
    for (const target of targets) {
      const found: OpenSlot[] = [];
      for (let date = target.appointmentDate; date <= situation.lastDate && found.length < ALTERNATIVES; date = addDays(date, 1)) {
        for (const slot of openOn(date)) if (found.length < ALTERNATIVES) found.push(slot);
      }
      result.set(target.id, found);
    }
    return result;
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
    const situation = await this.situation(manager, doctor, applyFrom);
    const overrides = await this.overridesFor(manager, doctor.id, applyFrom, situation.lastDate);
    const proposed = { startTime: input.startTime, endTime: input.endTime };
    const plan = planChange({ row: toRule(row), proposed, rules: situation.rules, overrides, doctor: situation.elastic, applyFrom, lastDate: situation.lastDate });

    // Reducing hours: which booked appointments would be left outside them, and what else is open for each.
    const afterRules = situation.rules.map((rule) => (rule.id === row.id ? { ...rule, ...proposed } : rule));
    const upcoming = this.upcoming(situation.live, situation.clock);
    const affectedIds = plan.problems.length === 0 && (plan.kind === 'SHRINK' || plan.kind === 'MIXED') ? new Set(findAffected({ appointments: upcoming.map(placed), rules: situation.rules, afterRules, overrides, doctor: situation.elastic })) : new Set<string>();
    const affected = upcoming.filter((appointment) => affectedIds.has(appointment.id));
    const alternatives = this.alternatives(affected, situation, afterRules, overrides);
    return { doctor, row, applyFrom, split, plan, proposed, affected, alternatives };
  }

  private describe(planned: { row: Availability; applyFrom: string; split: boolean; plan: ChangePlan; proposed: Window; affected: Appointment[]; alternatives: Map<string, OpenSlot[]> }) {
    const { row, applyFrom, split, plan, proposed, affected, alternatives } = planned;
    const problems = [...plan.problems];
    if (plan.kind === 'NONE') problems.push('These are already the hours.');
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
      /** Booked appointments the new hours would leave outside them. They stay booked; each patient is asked to choose a new time. */
      affectedAppointments,
      affectedCount: affectedAppointments.length,
      /** How many of them have no other open time to move to. */
      withoutAlternatives: affectedAppointments.filter((appointment) => appointment.alternatives.length === 0).length,
      canApply: problems.length === 0,
    };
  }
}

const placed = (appointment: Appointment): Placed => ({ id: appointment.id, date: appointment.appointmentDate, startTime: appointment.startTime, endTime: appointment.endTime });

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

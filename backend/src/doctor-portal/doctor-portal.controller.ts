import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { dateSchema, timeSchema } from '../scheduling/schemas.js';
import { AvailabilityChangeService } from './availability-change.service.js';
import { DoctorPortalService } from './doctor-portal.service.js';

const capacitySchema = z.int().min(1).max(200);

// Query strings ignore unknown keys (tracking parameters); request bodies stay strict.
const appointmentsQuery = z.object({ scope: z.enum(['upcoming', 'all']).optional() });

// Slot length in minutes: long enough to be a real visit, short enough to fit a session.
const settingsSchema = z
  .strictObject({
    /** How long each appointment is. */
    consultationMinutes: z.int().min(5).max(120).optional(),
    /** How often a new slot starts; null follows the appointment length. Shorter than the length gives overlapping slots. */
    slotIntervalMinutes: z.int().min(5).max(120).nullable().optional(),
  })
  .refine((value) => value.consultationMinutes !== undefined || value.slotIntervalMinutes !== undefined, { message: 'Send consultationMinutes, slotIntervalMinutes or both.' });

// A doctor must say why: the patient reads this reason in their appointment history.
const cancelSchema = z.strictObject({
  reason: z.string().trim().min(3, 'must be at least 3 characters').max(200, 'must be at most 200 characters'),
});
const appointmentIdParam = z.strictObject({ id: z.uuid() });

const profileSchema = z.strictObject({
  name: z.string().trim().min(2, 'must be at least 2 characters').max(100, 'must be at most 100 characters'),
  specialtyId: z.uuid('must be one of the listed specialties'),
  clinicId: z.uuid('must be one of the listed clinics'),
  consultationFee: z.int('must be a whole number').min(0, 'cannot be negative').max(100_000, 'is too high'),
  bio: z.string().trim().max(1000, 'must be at most 1000 characters').nullable(),
});

// What every availability row can say. STREAM (the default) takes one patient per slot; WAVE takes capacityPerSlot.
// Optional fields also accept null, so a row read from GET /availability can be sent back as it is.
const availabilityFields = {
  startTime: timeSchema,
  endTime: timeSchema,
  /** STREAM only: the most bookings in the whole session. */
  capacity: capacitySchema.nullish(),
  schedulingMode: z.enum(['STREAM', 'WAVE']).optional(),
  slotDurationMinutes: z.int().min(5).max(120).nullish(),
  capacityPerSlot: z.int().min(1).max(100).optional(),
  effectiveFrom: dateSchema.nullish(),
  effectiveTo: dateSchema.nullish(),
};

const replaceWeeklySchema = z.strictObject({
  // `id` is what GET returns for a row; it is not needed to save (unchanged rows are recognised by their values).
  // `maxBooked` and `overCapacity` are read-only facts GET returns with each row; they are accepted and ignored so a row can be sent back as it is.
  hours: z.array(z.strictObject({ id: z.uuid().optional(), dayOfWeek: z.int().min(0).max(6), maxBooked: z.unknown().optional(), overCapacity: z.unknown().optional(), ...availabilityFields })).max(42),
  // Removing a session that has bookings: agree they stay booked until each patient chooses a new time.
  acknowledge: z.boolean().optional(),
});

const oneTimeSchema = z.strictObject({ date: dateSchema, ...availabilityFields });
const idParam = z.strictObject({ id: z.uuid() });
const capacityChangeSchema = z.strictObject({ capacityPerSlot: z.int().min(1).max(100) });

// Changing the hours of an existing session. `applyFrom` is for recurring sessions: earlier dates keep their hours.
const hoursChangeSchema = z.strictObject({ startTime: timeSchema, endTime: timeSchema, applyFrom: dateSchema.optional() });
const applyHoursChangeSchema = hoursChangeSchema.extend({
  from: z.strictObject({ startTime: timeSchema, endTime: timeSchema }),
  // Reducing hours: agree that affected appointments stay booked until each patient chooses a new time (patients pick for themselves).
  acknowledge: z.boolean().optional(),
});
const outsideQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });
const askNewTimeSchema = z.strictObject({}).optional();

// A day off needs only a date. Add a start and an end to block just that part of the day. Custom hours also need a capacity.
const dateOverrideSchema = z.discriminatedUnion('isAvailable', [
  z.strictObject({
    date: dateSchema,
    isAvailable: z.literal(false),
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
    reason: z.string().max(200).optional(),
    acknowledge: z.boolean().optional(),
  }),
  z.strictObject({
    date: dateSchema,
    isAvailable: z.literal(true),
    startTime: timeSchema,
    endTime: timeSchema,
    capacity: capacitySchema,
    reason: z.string().max(200).optional(),
    acknowledge: z.boolean().optional(),
  }),
]);

const dateParam = z.strictObject({ date: dateSchema });
// DELETE requests carry the doctor's agreement in the query string: ?acknowledge=true
const acknowledgeQuery = z.object({ acknowledge: z.enum(['true', 'false']).optional() });

const scheduleQuery = z.object({ days: z.coerce.number().int().min(1).max(60).optional() });
const cancelTimeSchema = z.strictObject({ date: dateSchema, startTime: timeSchema, endTime: timeSchema, reason: z.string().trim().max(200).optional() });

/** Everything here acts on the signed-in doctor's own profile only. */
@Controller('doctor-portal')
@UseGuards(AuthGuard)
@Roles('DOCTOR')
export class DoctorPortalController {
  constructor(
    private readonly portal: DoctorPortalService,
    private readonly changes: AvailabilityChangeService,
  ) {}

  @Get('appointments')
  appointments(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(appointmentsQuery)) query: z.infer<typeof appointmentsQuery>,
  ) {
    return this.portal.appointments(user, query.scope ?? 'upcoming');
  }

  /** Booked appointments that are outside the doctor's current hours, with open times and whether the patient was asked to move. */
  @Get('appointments/outside-hours')
  outsideHours(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(outsideQuery)) query: z.infer<typeof outsideQuery>) {
    return this.changes.outsideHours(user, query);
  }

  /** What needs the doctor: patients needing a new time, with no response after the reminders, or with no other time open. */
  @Get('attention')
  attention(@CurrentUser() user: AuthUser) {
    return this.changes.attention(user);
  }

  /** The doctor's recent reductions of hours and how many of their affected appointments are still unresolved. */
  @Get('schedule-changes')
  scheduleChanges(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(historyQuery)) query: z.infer<typeof historyQuery>) {
    return this.changes.history(user, query.limit);
  }

  /** Asks the patient to choose a new time. It moves nothing: the patient confirms the move themselves. */
  @Post('appointments/:id/ask-new-time')
  @HttpCode(200)
  askNewTime(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(appointmentIdParam)) params: z.infer<typeof appointmentIdParam>,
    @Body(new ZodValidationPipe(askNewTimeSchema)) _body: z.infer<typeof askNewTimeSchema>,
  ) {
    return this.changes.askNewTime(user, params.id);
  }

  @Post('appointments/:id/cancel')
  @HttpCode(200)
  cancelAppointment(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(appointmentIdParam)) params: z.infer<typeof appointmentIdParam>,
    @Body(new ZodValidationPipe(cancelSchema)) body: z.infer<typeof cancelSchema>,
  ) {
    return this.portal.cancelAppointment(user, params.id, body.reason);
  }

  @Get('availability')
  availability(@CurrentUser() user: AuthUser) {
    return this.portal.availability(user);
  }

  @Get('schedule')
  schedule(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(scheduleQuery)) query: z.infer<typeof scheduleQuery>,
  ) {
    return this.portal.schedule(user, query.days ?? 14);
  }

  @Post('schedule/cancel')
  @HttpCode(200)
  cancelTime(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(cancelTimeSchema)) body: z.infer<typeof cancelTimeSchema>,
  ) {
    return this.portal.cancelTime(user, body);
  }

  @Get('profile')
  profile(@CurrentUser() user: AuthUser) {
    return this.portal.profile(user);
  }

  @Put('profile')
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(profileSchema)) body: z.infer<typeof profileSchema>,
  ) {
    return this.portal.updateProfile(user, body);
  }

  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(settingsSchema)) body: z.infer<typeof settingsSchema>,
  ) {
    return this.portal.updateSettings(user, body);
  }

  @Put('availability/weekly')
  replaceWeekly(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(replaceWeeklySchema)) body: z.infer<typeof replaceWeeklySchema>,
  ) {
    return this.portal.replaceWeekly(user, body.hours, body.acknowledge);
  }

  @Post('availability/one-time')
  addOneTime(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(oneTimeSchema)) body: z.infer<typeof oneTimeSchema>,
  ) {
    return this.portal.addOneTime(user, body);
  }

  @Delete('availability/one-time/:id')
  deleteOneTime(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Query(new ZodValidationPipe(acknowledgeQuery)) query: z.infer<typeof acknowledgeQuery>,
  ) {
    return this.portal.deleteOneTime(user, params.id, query.acknowledge === 'true');
  }

  /** Raises or lowers the patients per slot of one Wave session. Never cancels or moves anyone; see AvailabilityChangeService.setCapacity. */
  @Post('availability/:id/capacity')
  @HttpCode(200)
  setCapacity(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(capacityChangeSchema)) body: z.infer<typeof capacityChangeSchema>,
  ) {
    return this.changes.setCapacity(user, params.id, body.capacityPerSlot);
  }

  /** Shows what changing a session's hours would do, without doing it. */
  @Post('availability/:id/change/preview')
  @HttpCode(200)
  previewChange(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(hoursChangeSchema)) body: z.infer<typeof hoursChangeSchema>,
  ) {
    return this.changes.preview(user, params.id, body);
  }

  @Post('availability/:id/change')
  @HttpCode(200)
  applyChange(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(applyHoursChangeSchema)) body: z.infer<typeof applyHoursChangeSchema>,
  ) {
    return this.changes.apply(user, params.id, body);
  }

  @Put('availability/overrides')
  upsertOverride(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dateOverrideSchema)) body: z.infer<typeof dateOverrideSchema>,
  ) {
    const { acknowledge, ...override } = body;
    return this.portal.upsertOverride(user, override, acknowledge);
  }

  @Delete('availability/overrides/:date')
  deleteOverride(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(dateParam)) params: z.infer<typeof dateParam>,
    @Query(new ZodValidationPipe(acknowledgeQuery)) query: z.infer<typeof acknowledgeQuery>,
  ) {
    return this.portal.deleteOverride(user, params.date, query.acknowledge === 'true');
  }
}

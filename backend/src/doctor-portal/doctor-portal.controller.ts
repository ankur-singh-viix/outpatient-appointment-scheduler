import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { dateSchema, timeSchema } from '../scheduling/schemas.js';
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
  hours: z.array(z.strictObject({ id: z.uuid().optional(), dayOfWeek: z.int().min(0).max(6), ...availabilityFields })).max(42),
});

const oneTimeSchema = z.strictObject({ date: dateSchema, ...availabilityFields });
const idParam = z.strictObject({ id: z.uuid() });

// A day off needs only a date. Add a start and an end to block just that part of the day. Custom hours also need a capacity.
const dateOverrideSchema = z.discriminatedUnion('isAvailable', [
  z.strictObject({
    date: dateSchema,
    isAvailable: z.literal(false),
    startTime: timeSchema.optional(),
    endTime: timeSchema.optional(),
    reason: z.string().max(200).optional(),
  }),
  z.strictObject({
    date: dateSchema,
    isAvailable: z.literal(true),
    startTime: timeSchema,
    endTime: timeSchema,
    capacity: capacitySchema,
    reason: z.string().max(200).optional(),
  }),
]);

const dateParam = z.strictObject({ date: dateSchema });

/** Everything here acts on the signed-in doctor's own profile only. */
@Controller('doctor-portal')
@UseGuards(AuthGuard)
@Roles('DOCTOR')
export class DoctorPortalController {
  constructor(private readonly portal: DoctorPortalService) {}

  @Get('appointments')
  appointments(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(appointmentsQuery)) query: z.infer<typeof appointmentsQuery>,
  ) {
    return this.portal.appointments(user, query.scope ?? 'upcoming');
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
    return this.portal.replaceWeekly(user, body.hours);
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
  ) {
    return this.portal.deleteOneTime(user, params.id);
  }

  @Put('availability/overrides')
  upsertOverride(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dateOverrideSchema)) body: z.infer<typeof dateOverrideSchema>,
  ) {
    return this.portal.upsertOverride(user, body);
  }

  @Delete('availability/overrides/:date')
  deleteOverride(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(dateParam)) params: z.infer<typeof dateParam>,
  ) {
    return this.portal.deleteOverride(user, params.date);
  }
}

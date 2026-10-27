import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
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

const replaceWeeklySchema = z.strictObject({
  hours: z
    .array(
      z.strictObject({
        dayOfWeek: z.int().min(0).max(6),
        startTime: timeSchema,
        endTime: timeSchema,
        capacity: capacitySchema,
      }),
    )
    .max(42),
});

// A day off needs only a date; custom hours also need a start, an end and a capacity.
const dateOverrideSchema = z.discriminatedUnion('isAvailable', [
  z.strictObject({ date: dateSchema, isAvailable: z.literal(false), reason: z.string().max(200).optional() }),
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

  @Get('availability')
  availability(@CurrentUser() user: AuthUser) {
    return this.portal.availability(user);
  }

  @Put('availability/weekly')
  replaceWeekly(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(replaceWeeklySchema)) body: z.infer<typeof replaceWeeklySchema>,
  ) {
    return this.portal.replaceWeekly(user, body.hours);
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

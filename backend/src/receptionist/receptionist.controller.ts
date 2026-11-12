import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { dateSchema, timeSchema } from '../scheduling/schemas.js';
import { ReceptionistService } from './receptionist.service.js';

const patientSearchQuery = z.object({ search: z.string().trim().min(2, 'type at least 2 characters').max(100) });
const appointmentsQuery = z.object({ date: dateSchema.optional(), doctorId: z.uuid().optional() });
const bookSchema = z.strictObject({
  patientId: z.uuid(),
  doctorId: z.uuid(),
  date: dateSchema,
  startTime: timeSchema,
  availabilityId: z.uuid().optional(),
});
const idParam = z.strictObject({ id: z.uuid() });
const cancelSchema = z.strictObject({ reason: z.string().trim().max(200).optional() }).optional();
const rescheduleSchema = z.strictObject({ date: dateSchema, startTime: timeSchema });

/** Receptionists act on the clinics they are assigned to (the service checks that on every request). */
@Controller('receptionist')
@UseGuards(AuthGuard)
@Roles('RECEPTIONIST')
export class ReceptionistController {
  constructor(private readonly reception: ReceptionistService) {}

  @Get('doctors')
  doctors(@CurrentUser() user: AuthUser) {
    return this.reception.listDoctors(user);
  }

  @Get('patients')
  patients(@Query(new ZodValidationPipe(patientSearchQuery)) query: z.infer<typeof patientSearchQuery>) {
    return this.reception.searchPatients(query.search);
  }

  @Get('appointments')
  appointments(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(appointmentsQuery)) query: z.infer<typeof appointmentsQuery>) {
    return this.reception.listAppointments(user, query);
  }

  @Post('appointments')
  book(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(bookSchema)) body: z.infer<typeof bookSchema>) {
    return this.reception.book(user, body);
  }

  @Post('appointments/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(cancelSchema)) body: z.infer<typeof cancelSchema>,
  ) {
    return this.reception.cancel(user, params.id, body?.reason);
  }

  /** Responds with the NEW appointment; the old one stays as a cancelled record. */
  @Post('appointments/:id/reschedule')
  reschedule(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(rescheduleSchema)) body: z.infer<typeof rescheduleSchema>,
  ) {
    return this.reception.reschedule(user, params.id, body);
  }
}

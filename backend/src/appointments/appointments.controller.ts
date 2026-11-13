import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { dateSchema, timeSchema } from '../scheduling/schemas.js';
import { AppointmentHistoryService } from './appointment-history.service.js';
import { AppointmentsService } from './appointments.service.js';

const bookAppointmentSchema = z.strictObject({
  doctorId: z.uuid(),
  date: dateSchema,
  startTime: timeSchema,
  availabilityId: z.uuid().optional(),
});

const idParam = z.strictObject({ id: z.uuid() });
// A page of other times: how many (default 8), and where the previous page ended.
const alternativesQuery = z.object({ limit: z.coerce.number().int().min(1).max(30).optional(), cursor: z.string().max(100).optional() });
// The body is optional: a bare POST cancels without a reason.
const cancelSchema = z.strictObject({ reason: z.string().trim().max(200).optional() }).optional();
const rescheduleSchema = z.strictObject({ date: dateSchema, startTime: timeSchema });
const noBody = z.strictObject({}).optional();

@Controller('appointments')
@UseGuards(AuthGuard)
@Roles('PATIENT')
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly history: AppointmentHistoryService,
  ) {}

  @Post()
  book(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(bookAppointmentSchema)) body: z.infer<typeof bookAppointmentSchema>,
  ) {
    return this.appointments.book(user, body);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.appointments.listForPatient(user);
  }

  /** Other open times the patient can move this appointment to, nearest first, a page at a time (read-only). */
  @Get(':id/alternatives')
  alternatives(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Query(new ZodValidationPipe(alternativesQuery)) query: z.infer<typeof alternativesQuery>,
  ) {
    return this.appointments.alternativesFor(user, params.id, query);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(cancelSchema)) body: z.infer<typeof cancelSchema>,
  ) {
    return this.appointments.cancel(user, params.id, body?.reason);
  }

  /**
   * Removes a PAST (cancelled, completed) booking from the patient's own list. Nothing is deleted: receipts, refunds and the doctor's
   * records are unchanged. Refused while it is active or money is unsettled. Asking again is answered, not repeated.
   */
  @Post(':id/hide-from-history')
  @HttpCode(200)
  hideFromHistory(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.history.hide(user, params.id);
  }

  /** Responds with the NEW appointment; the old one stays as a cancelled record. */
  @Post(':id/reschedule')
  reschedule(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(rescheduleSchema)) body: z.infer<typeof rescheduleSchema>,
  ) {
    return this.appointments.reschedule(user, params.id, body);
  }
}

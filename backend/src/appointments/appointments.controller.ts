import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { dateSchema, timeSchema } from '../scheduling/schemas.js';
import { AppointmentsService } from './appointments.service.js';

const bookAppointmentSchema = z.strictObject({
  doctorId: z.uuid(),
  date: dateSchema,
  startTime: timeSchema,
});

const idParam = z.strictObject({ id: z.uuid() });
// The body is optional: a bare POST cancels without a reason.
const cancelSchema = z.strictObject({ reason: z.string().trim().max(200).optional() }).optional();
const rescheduleSchema = z.strictObject({ date: dateSchema, startTime: timeSchema });

@Controller('appointments')
@UseGuards(AuthGuard)
@Roles('PATIENT')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

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

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(cancelSchema)) body: z.infer<typeof cancelSchema>,
  ) {
    return this.appointments.cancel(user, params.id, body?.reason);
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

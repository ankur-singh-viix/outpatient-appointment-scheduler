import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
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
}

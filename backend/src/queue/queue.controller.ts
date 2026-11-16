import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { isValidDate } from '../scheduling/calendar.js';
import { dateSchema } from '../scheduling/schemas.js';
import { QueueService } from './queue.service.js';

const idParam = z.strictObject({ id: z.uuid() });
// A real calendar date (2026-02-30 has the right shape but is not one, and must be a 400, never a database error).
const queueDate = dateSchema.refine(isValidDate, { message: 'is not a real calendar date' });
const dateQuery = z.strictObject({ date: queueDate.optional() });
const receptionQuery = z.strictObject({ doctorId: z.uuid().optional(), date: queueDate.optional() });
// Queue actions carry no body: what happens is decided by the server from the entry and who is asking, never by the browser.
const noBody = z.strictObject({}).optional();

/**
 * Doctor-wise queue management. Every route names the roles that may use it, and each service method checks the rest: a receptionist
 * only reaches doctors who assigned them, a doctor only their own queue, and a patient only their own entry.
 * Someone else's appointment or queue entry looks like a missing one (404).
 */
@Controller('queue')
@UseGuards(AuthGuard)
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  // ---- Receptionist ----

  /** The queue of each doctor who assigned this receptionist (or one doctor), for a day (today by default). */
  @Get('reception')
  @Roles('RECEPTIONIST')
  board(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(receptionQuery)) query: z.infer<typeof receptionQuery>) {
    return this.queue.receptionBoard(user, query);
  }

  /** The patient has arrived: checks them in for today's CONFIRMED appointment and gives them the next token in that doctor's queue. */
  @Post('reception/appointments/:id/check-in')
  @HttpCode(200)
  @Roles('RECEPTIONIST')
  checkIn(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.queue.checkIn(user, params.id);
  }

  /** After the consultation: checks the patient out. Only possible once the doctor has completed it. */
  @Post('reception/entries/:id/check-out')
  @HttpCode(200)
  @Roles('RECEPTIONIST')
  checkOut(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.queue.checkOut(user, params.id);
  }

  /** Skips a patient who is not there. */
  @Post('reception/entries/:id/skip')
  @HttpCode(200)
  @Roles('RECEPTIONIST')
  skipAtDesk(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.queue.skip(user, params.id);
  }

  /** Puts a skipped patient back in the queue, with the token they had. Receptionists only. */
  @Post('reception/entries/:id/return')
  @HttpCode(200)
  @Roles('RECEPTIONIST')
  returnToQueue(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.queue.returnToQueue(user, params.id);
  }

  // ---- Doctor ----

  /** The signed-in doctor's own queue: who is being served, who is waiting and in what order. */
  @Get('doctor')
  @Roles('DOCTOR')
  doctorQueue(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(dateQuery)) query: z.infer<typeof dateQuery>) {
    return this.queue.doctorQueue(user, query.date);
  }

  /** Calls the next waiting patient (lowest token). Refused while someone is still being served. */
  @Post('doctor/call-next')
  @HttpCode(200)
  @Roles('DOCTOR')
  callNext(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.queue.callNext(user);
  }

  /** Completes the consultation of the patient being served. */
  @Post('doctor/entries/:id/complete')
  @HttpCode(200)
  @Roles('DOCTOR')
  complete(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.queue.complete(user, params.id);
  }

  /** Skips a patient who was called but is not there. */
  @Post('doctor/entries/:id/skip')
  @HttpCode(200)
  @Roles('DOCTOR')
  skipAsDoctor(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.queue.skip(user, params.id);
  }

  // ---- Patient ----

  /** The signed-in patient's own place in today's queue: token, who is being served, and how many are ahead and behind. */
  @Get('mine')
  @Roles('PATIENT')
  mine(@CurrentUser() user: AuthUser) {
    return this.queue.myQueue(user);
  }

  // ---- Admin ----

  /** Every doctor's queue for a day as counts and tokens only (no patient names). */
  @Get('admin')
  @Roles('ADMIN')
  adminBoard(@Query(new ZodValidationPipe(dateQuery)) query: z.infer<typeof dateQuery>) {
    return this.queue.adminBoard(query.date);
  }
}

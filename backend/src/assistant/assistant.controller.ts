import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AssistantActionsService } from './actions/assistant-actions.service.js';
import { DoctorActionsService } from './actions/doctor-actions.service.js';
import { ScheduleChangeActionsService } from './actions/schedule-change-actions.service.js';
import { AssistantService } from './assistant.service.js';

/** The recent conversation. Strict: the client can send nothing but turns of text (no ids, no roles to act as, no tool results). */
const chatSchema = z
  .strictObject({
    messages: z
      .array(
        z.strictObject({
          role: z.enum(['user', 'assistant']),
          content: z.string().trim().min(1, 'cannot be empty').max(2000, 'is too long (2000 characters at most)'),
        }),
      )
      .min(1)
      .max(40),
    // How the person is talking, as hints for the model's wording only. They change no permission and no tool.
    voice: z.boolean().optional(),
    language: z.enum(['en', 'hi', 'hinglish']).optional(),
  })
  .refine((body) => body.messages.at(-1)?.role === 'user', { message: 'The last message must be from the user.', path: ['messages'] });

const refParam = z.strictObject({ id: z.uuid() });
// The confirm and dismiss calls carry NO body: what runs is what was stored when the card was made, never what the browser sends.
const noBody = z.strictObject({}).optional();
// A doctor's schedule-change card is confirmed with its signed token (the token is the whole request; nothing else is accepted).
const scheduleTokenSchema = z.strictObject({ token: z.string().min(20).max(2000) });

/** The text assistant for doctors and patients. Who is asking, and in which role, comes only from the verified sign-in. */
@Controller('assistant')
@UseGuards(AuthGuard)
@Roles('DOCTOR', 'PATIENT')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly actions: AssistantActionsService,
    private readonly scheduleChanges: ScheduleChangeActionsService,
    private readonly doctorActions: DoctorActionsService,
  ) {}

  @Post('chat')
  @HttpCode(200)
  chat(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(chatSchema)) body: z.infer<typeof chatSchema>) {
    return this.assistant.chat(user, body.messages, { voice: body.voice, language: body.language });
  }

  /**
   * Where one of the patient's own prepared actions stands. An action that was confirmed but never finished is reconciled from the
   * appointment data (never re-run), so this answers what really happened: done, not applied, still running, or uncertain.
   */
  @Get('actions/:id')
  @Roles('PATIENT')
  actionStatus(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(refParam)) params: z.infer<typeof refParam>) {
    return this.actions.status(user, params.id);
  }

  /**
   * The patient pressed Confirm on a card the assistant prepared. Patients only. The reference must belong to the signed-in patient, be
   * unused and unexpired; the stored action then runs through the existing booking services, which check everything again.
   */
  @Post('actions/:id/confirm')
  @HttpCode(200)
  @Roles('PATIENT')
  confirm(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(refParam)) params: z.infer<typeof refParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.actions.confirm(user, params.id);
  }

  /**
   * The doctor pressed Confirm on a schedule-change card. Doctors only. The body is the card's signed token and nothing else: it works
   * only for the doctor it was made for, before it expires, and only while the schedule is still as it was previewed. The change then
   * runs through the existing availability-change service, which re-checks everything, records the audit row and queues the patient notices.
   */
  @Post('schedule-changes/confirm')
  @HttpCode(200)
  @Roles('DOCTOR')
  confirmScheduleChange(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(scheduleTokenSchema)) body: z.infer<typeof scheduleTokenSchema>) {
    return this.scheduleChanges.confirm(user, body.token);
  }

  /**
   * The doctor pressed Confirm on a card for cancelling or moving an appointment, adding working hours or blocking a day. Doctors only.
   * The body is the card's signed token and nothing else; it works only for that doctor, before it expires, and only while what was
   * previewed is still true. The action then runs through the same service the app already uses for it, which checks everything again.
   */
  @Post('doctor-actions/confirm')
  @HttpCode(200)
  @Roles('DOCTOR')
  confirmDoctorAction(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(scheduleTokenSchema)) body: z.infer<typeof scheduleTokenSchema>) {
    return this.doctorActions.confirm(user, body.token);
  }

  /** The patient pressed Cancel on the card: it can no longer be confirmed. */
  @Post('actions/:id/dismiss')
  @HttpCode(200)
  @Roles('PATIENT')
  dismiss(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(refParam)) params: z.infer<typeof refParam>, @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>) {
    return this.actions.dismiss(user, params.id);
  }
}

import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PaymentsService } from './payments.service.js';

const verifySchema = z.strictObject({
  razorpayOrderId: z.string().min(1).max(64),
  razorpayPaymentId: z.string().min(1).max(64),
  razorpaySignature: z.string().min(1).max(256),
});
const appointmentParam = z.strictObject({ id: z.uuid() });
const paymentParam = z.strictObject({ id: z.uuid() });
const refundSchema = z.strictObject({
  // Whole paise; leave it out to refund everything that is left.
  amountPaise: z.number().int().positive().optional(),
  reason: z.string().trim().min(3).max(200),
  // Chosen by the screen once per click, so a double submit or a retry refunds once.
  requestId: z.uuid(),
});

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Razorpay calls this, not a person, so there is no sign-in. Trust comes from the signature over the raw body. Needs the app
   * to be created with `rawBody: true` (main.ts does); without it every call is refused.
   */
  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ) {
    return this.payments.handleWebhook(request.rawBody, signature, eventId);
  }

  /** Whether online payment is on, and the refund rules to show patients. Nothing secret. */
  @Get('config')
  config() {
    return this.payments.publicConfig();
  }

  /** The browser reports a finished payment; the signature is verified before anything is confirmed. */
  @Post('verify')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @Roles('PATIENT')
  verify(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(verifySchema)) body: z.infer<typeof verifySchema>) {
    return this.payments.verify(user, body);
  }

  /** Reopen Checkout for a booking still waiting for payment. */
  @Post('appointments/:id/checkout')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @Roles('PATIENT')
  checkout(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(appointmentParam)) params: z.infer<typeof appointmentParam>) {
    return this.payments.resumeCheckout(user, params.id);
  }

  /** Payment history with receipts and refunds. */
  @Get('mine')
  @UseGuards(AuthGuard)
  @Roles('PATIENT')
  mine(@CurrentUser() user: AuthUser) {
    return this.payments.listForPatient(user);
  }

  /** Administrators only: refund all or part of what is left on a payment. */
  @Post(':id/refund')
  @UseGuards(AuthGuard)
  @Roles('ADMIN')
  refund(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(paymentParam)) params: z.infer<typeof paymentParam>,
    @Body(new ZodValidationPipe(refundSchema)) body: z.infer<typeof refundSchema>,
  ) {
    return this.payments.refundAsAdmin(user, params.id, body);
  }
}

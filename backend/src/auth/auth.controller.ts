import { Body, Controller, Get, Headers, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { profileSchema } from './auth.schemas.js';
import { CurrentUser, Roles } from './auth.decorators.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import type { AuthUser } from './auth.types.js';
import { BLOOD_GROUPS } from './patient-uhid.js';
import { InvitationService } from './invitation.service.js';
import { SignupService, type ProfileInput } from './signup.service.js';

const loginSchema = z.strictObject({
  email: z.email('must be a valid email address'),
  password: z.string().min(1, 'is required').max(200),
});

const emailSchema = z.email('must be a valid email address').max(255);

const registerSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(8, 'must be at least 8 characters').max(128, 'must be at most 128 characters'),
});
const verifySchema = z.strictObject({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, 'must be the 6-digit code from your email'),
});
const resendSchema = z.strictObject({ email: emailSchema });
const inviteTokenSchema = z.strictObject({ token: z.string().min(20).max(2000) });
const acceptInviteSchema = z.strictObject({
  token: z.string().min(20).max(2000),
  password: z.string().min(8, 'must be at least 8 characters').max(128, 'must be at most 128 characters'),
});

const medicalText = z.union([z.string().trim().max(2000), z.null()]).optional();
const medicalProfileSchema = z
  .strictObject({
    bloodGroup: z.union([z.enum(BLOOD_GROUPS), z.null()]).optional(),
    allergies: medicalText,
    sensitivities: medicalText,
    medicalConditions: medicalText,
    currentMedications: medicalText,
    previousSurgeries: medicalText,
    otherMedicalInfo: medicalText,
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one medical field to update.' });


@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly signup: SignupService,
    private readonly invitations: InvitationService,
  ) {}

  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body.email, body.password);
  }

  /** Step 1: stores a pending sign-up and emails a 6-digit code. */
  @Post('register')
  @HttpCode(202)
  register(@Body(new ZodValidationPipe(registerSchema)) body: z.infer<typeof registerSchema>) {
    return this.signup.register(body.email, body.password);
  }

  /** Step 2: checks the code and returns a short-lived sign-up token. */
  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body(new ZodValidationPipe(verifySchema)) body: z.infer<typeof verifySchema>) {
    return this.signup.verifyEmail(body.email, body.code);
  }

  @Post('resend-code')
  @HttpCode(202)
  resendCode(@Body(new ZodValidationPipe(resendSchema)) body: z.infer<typeof resendSchema>) {
    return this.signup.resendCode(body.email);
  }

  /** Step 3: creates the real account with the chosen role. Needs the sign-up token from step 2 (or from signing in). */
  @Post('complete-profile')
  completeProfile(
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(profileSchema)) body: z.infer<typeof profileSchema>,
  ) {
    return this.signup.completeProfile(authorization, body as ProfileInput);
  }

  /** Whose account an invitation link is for (so the page can greet them), or why the link is no good. */
  @Post('invitations/inspect')
  @HttpCode(200)
  inspectInvitation(@Body(new ZodValidationPipe(inviteTokenSchema)) body: z.infer<typeof inviteTokenSchema>) {
    return this.invitations.inspect(body.token);
  }

  /** Sets the password for an invited receptionist (once) and signs them in. */
  @Post('invitations/accept')
  @HttpCode(200)
  acceptInvitation(@Body(new ZodValidationPipe(acceptInviteSchema)) body: z.infer<typeof acceptInviteSchema>) {
    return this.invitations.accept(body.token, body.password);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  /** The patient's own identity and medical profile, for My Profile. */
  @Get('me/profile')
  @UseGuards(AuthGuard)
  @Roles('PATIENT')
  profile(@CurrentUser() user: AuthUser) {
    return this.auth.patientProfile(user.id);
  }

  /** Updates the signed-in patient's own medical profile fields and appends history. */
  @Put('me/profile/medical')
  @UseGuards(AuthGuard)
  @Roles('PATIENT')
  updateMedicalProfile(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(medicalProfileSchema)) body: z.infer<typeof medicalProfileSchema>,
  ) {
    return this.auth.updatePatientMedicalProfile(user.id, body);
  }
}

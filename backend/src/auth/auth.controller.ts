import { Body, Controller, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { clinicNow } from '../scheduling/calendar.js';
import { dateSchema } from '../scheduling/schemas.js';
import { CurrentUser } from './auth.decorators.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import type { AuthUser } from './auth.types.js';
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

// 50 characters each keeps "Dr. <first> <last>" inside the 120-character users.name column.
const nameSchema = z.string().trim().min(1, 'is required').max(50, 'must be at most 50 characters');

const patientProfileSchema = z.strictObject({
  role: z.literal('PATIENT'),
  firstName: nameSchema,
  lastName: nameSchema,
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'must be a valid phone number')
    .optional(),
  dateOfBirth: dateSchema
    .refine((value) => value >= '1900-01-01' && value <= clinicNow(loadConfig().clinicTimezone).date, 'must be a real date of birth, not in the future')
    .optional(),
  gender: z.enum(['Male', 'Female', 'Other', 'Prefer not to say']).optional(),
});

const doctorProfileSchema = z.strictObject({
  role: z.literal('DOCTOR'),
  firstName: nameSchema,
  lastName: nameSchema,
  specialtyId: z.uuid('must be one of the listed specialties'),
  clinicId: z.uuid('must be one of the listed clinics'),
  consultationFee: z.int('must be a whole number').min(0, 'cannot be negative').max(100_000, 'is too high'),
  bio: z.string().trim().max(1000, 'must be at most 1000 characters').optional(),
});

const profileSchema = z.discriminatedUnion('role', [patientProfileSchema, doctorProfileSchema]);

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly signup: SignupService,
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

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}

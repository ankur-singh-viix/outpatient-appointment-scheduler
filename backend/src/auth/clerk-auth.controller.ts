import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { ProfileInput } from './account-creation.js';
import { profileSchema } from './auth.schemas.js';
import type { ClerkSignIn } from './auth.types.js';
import { ClerkAccountService } from './clerk-account.service.js';
import { ClerkIdentityGuard, ClerkSignInParam } from './clerk-identity.guard.js';

const linkSchema = z.strictObject({ password: z.string().min(1, 'is required').max(200) });

/**
 * The steps between "signed in with Clerk" and "has a CareSlot account". Each one needs a verified Clerk sign-in and
 * nothing more; none of them can be used to reach patient or doctor data.
 */
@Controller('auth/clerk')
@UseGuards(ClerkIdentityGuard)
export class ClerkAuthController {
  constructor(private readonly accounts: ClerkAccountService) {}

  /** Linked, needs a profile, needs to link an existing account, or blocked (unverified or ambiguous email). */
  @Get('status')
  status(@ClerkSignInParam() who: ClerkSignIn) {
    return this.accounts.status(who.clerkUserId);
  }

  /** Creates a new CareSlot account (patient or doctor) for this sign-in. Refused if the email already has an account. */
  @Post('complete-profile')
  completeProfile(
    @ClerkSignInParam() who: ClerkSignIn,
    @Body(new ZodValidationPipe(profileSchema)) body: z.infer<typeof profileSchema>,
  ) {
    return this.accounts.completeProfile(who.clerkUserId, body as ProfileInput);
  }

  /** Links an existing CareSlot account to this sign-in after proving ownership with the account's current password. */
  @Post('link')
  @HttpCode(200)
  link(@ClerkSignInParam() who: ClerkSignIn, @Body(new ZodValidationPipe(linkSchema)) body: z.infer<typeof linkSchema>) {
    return this.accounts.link(who.clerkUserId, body.password);
  }
}

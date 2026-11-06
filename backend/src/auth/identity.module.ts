import { Global, Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { CLERK_VERIFIER, createClerkVerifier } from './clerk-verifier.js';
import { IdentityService } from './identity.service.js';

/**
 * Global because AuthGuard is used by other modules (appointments, doctor portal) and needs these to tell a Clerk sign-in
 * from a legacy token. Without a Clerk secret key the verifier is a disabled stand-in and nothing changes.
 */
@Global()
@Module({
  providers: [IdentityService, { provide: CLERK_VERIFIER, useFactory: () => createClerkVerifier(loadConfig().clerk) }],
  exports: [IdentityService, CLERK_VERIFIER],
})
export class IdentityModule {}

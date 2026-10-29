import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { loadConfig } from '../config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ClerkAccountService } from './clerk-account.service.js';
import { ClerkAuthController } from './clerk-auth.controller.js';
import { ClerkIdentityGuard } from './clerk-identity.guard.js';
import { EMAIL_SENDER, createEmailSender } from './email-sender.js';
import { IdentityModule } from './identity.module.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [
    // Global so AuthGuard can verify tokens in every feature module.
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({ secret: loadConfig().jwtSecret, signOptions: { expiresIn: '8h' } }),
    }),
    IdentityModule,
  ],
  controllers: [AuthController, ClerkAuthController],
  providers: [
    AuthService,
    SignupService,
    ClerkAccountService,
    ClerkIdentityGuard,
    { provide: EMAIL_SENDER, useFactory: () => createEmailSender(loadConfig()) },
  ],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { loadConfig } from '../config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [
    // Global so AuthGuard can verify tokens in every feature module.
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({ secret: loadConfig().jwtSecret, signOptions: { expiresIn: '8h' } }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}

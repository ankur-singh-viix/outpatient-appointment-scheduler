import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { withDoctorTitle } from '../common/names.js';
import { loadConfig } from '../config.js';
import { Clinic, Doctor, EmailVerification, Patient, Specialty, User } from '../database/entities/index.js';
import { isUniqueViolation } from '../database/errors.js';
import { EMAIL_SENDER, type EmailSender } from './email-sender.js';
import { hashPassword, verifyPassword } from './password.js';
import { signSession } from './session.js';
import {
  CODE_TTL_MINUTES,
  MAX_CODE_ATTEMPTS,
  RESEND_SECONDS,
  SIGNUP_TOKEN_MINUTES,
  codeMatches,
  generateCode,
  hashCode,
  normalizeEmail,
  resendWaitSeconds,
} from './verification.js';

export type ProfileInput =
  | { role: 'PATIENT'; firstName: string; lastName: string; phone?: string; dateOfBirth?: string; gender?: string }
  | { role: 'DOCTOR'; firstName: string; lastName: string; specialtyId: string; clinicId: string; consultationFee: number; bio?: string };

/** The token given after the email is verified: it only allows finishing the profile, never acts as a session. */
interface SignupTokenPayload {
  purpose: 'signup';
  email: string;
}

/**
 * Sign-up in three steps, with nothing in `users` until the last one:
 * 1. register: store the email and a password HASH as a pending sign-up and email a 6-digit code;
 * 2. verify the code: the visitor receives a short-lived sign-up token;
 * 3. complete the profile as Patient or Doctor: only now are the real user (and patient or doctor) rows created.
 */
@Injectable()
export class SignupService {
  private readonly config = loadConfig();
  private readonly logger = new Logger(SignupService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(EmailVerification) private readonly pending: Repository<EmailVerification>,
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async register(rawEmail: string, password: string) {
    this.assertEmailConfigured();
    const email = normalizeEmail(rawEmail);
    if (await this.emailIsRegistered(this.users, email)) {
      throw new ConflictException('An account with this email already exists. Try signing in instead.');
    }
    const existing = await this.pending.findOneBy({ email });
    if (existing) this.assertCanSend(existing);

    const code = generateCode();
    await this.pending.save(
      this.pending.create({
        email,
        passwordHash: await hashPassword(password),
        codeHash: hashCode(code, email, this.config.jwtSecret),
        expiresAt: minutesFromNow(CODE_TTL_MINUTES),
        attempts: 0,
        verifiedAt: null,
        lastSentAt: new Date(),
      }),
    );
    await this.deliver(email, code);
    return { email, resendAvailableInSeconds: RESEND_SECONDS, delivery: this.deliveryHint() };
  }

  /** Sends a fresh code. The answer is the same whether or not the address has a pending sign-up. */
  async resendCode(rawEmail: string) {
    this.assertEmailConfigured();
    const email = normalizeEmail(rawEmail);
    const row = await this.pending.findOneBy({ email });
    if (row && !row.verifiedAt) {
      this.assertCanSend(row);
      const code = generateCode();
      row.codeHash = hashCode(code, email, this.config.jwtSecret);
      row.attempts = 0;
      row.expiresAt = minutesFromNow(CODE_TTL_MINUTES);
      row.lastSentAt = new Date();
      await this.pending.save(row);
      await this.deliver(email, code);
    }
    return { resendAvailableInSeconds: RESEND_SECONDS, delivery: this.deliveryHint() };
  }

  async verifyEmail(rawEmail: string, code: string) {
    const email = normalizeEmail(rawEmail);
    const row = await this.pending.findOneBy({ email });
    if (!row) throw new BadRequestException('That code is not valid. Please request a new one.');
    if (row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('That code has expired. Please request a new one.');
    }
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
      throw tooManyRequests('Too many incorrect attempts. Please request a new code.');
    }
    if (!codeMatches(code, email, this.config.jwtSecret, row.codeHash)) {
      await this.pending.increment({ email }, 'attempts', 1);
      const left = MAX_CODE_ATTEMPTS - (row.attempts + 1);
      throw new BadRequestException(
        left > 0
          ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`
          : 'That code is not correct, and you have no attempts left. Please request a new code.',
      );
    }
    row.verifiedAt = new Date();
    await this.pending.save(row);
    return { email, signupToken: await this.signupToken(email) };
  }

  async completeProfile(authorization: string | undefined, input: ProfileInput) {
    const email = await this.emailFromSignupToken(authorization);
    const row = await this.pending.findOneBy({ email });
    if (!row?.verifiedAt) throw new ForbiddenException('Please verify your email address first.');

    try {
      const user = await this.dataSource.transaction(async (manager) => {
        if (await this.emailIsRegistered(manager.getRepository(User), email)) {
          throw new ConflictException('An account with this email already exists. Try signing in instead.');
        }
        if (input.role === 'DOCTOR') {
          if (!(await manager.existsBy(Specialty, { id: input.specialtyId }))) {
            throw new BadRequestException('specialtyId: choose one of the listed specialties.');
          }
          if (!(await manager.existsBy(Clinic, { id: input.clinicId }))) {
            throw new BadRequestException('clinicId: choose one of the listed clinics.');
          }
        }

        const created = await manager.save(
          manager.create(User, { name: displayName(input), email, passwordHash: row.passwordHash, googleId: null, role: input.role }),
        );
        if (input.role === 'PATIENT') {
          await manager.save(
            manager.create(Patient, {
              userId: created.id,
              phone: input.phone ?? null,
              dateOfBirth: input.dateOfBirth ?? null,
              gender: input.gender ?? null,
              address: null,
            }),
          );
        } else {
          await manager.save(
            manager.create(Doctor, {
              userId: created.id,
              clinicId: input.clinicId,
              specialtyId: input.specialtyId,
              consultationMinutes: 15,
              defaultDailyCapacity: 20,
              consultationFee: input.consultationFee,
              bio: input.bio ?? null,
            }),
          );
        }
        await manager.delete(EmailVerification, { email });
        return created;
      });
      return signSession(this.jwt, user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('An account with this email already exists. Try signing in instead.');
      }
      throw error;
    }
  }

  /**
   * Signing in with an email that has no account yet, but a pending sign-up whose password matches:
   * - email not verified yet: the client is told to verify (so a closed browser tab does not strand the visitor);
   * - verified but profile not finished: the client gets a sign-up token and continues onboarding.
   */
  async loginPending(rawEmail: string, password: string) {
    const email = normalizeEmail(rawEmail);
    const row = await this.pending.findOneBy({ email });
    if (!row || !(await verifyPassword(password, row.passwordHash))) {
      throw new UnauthorizedException('Incorrect email or password.');
    }
    if (!row.verifiedAt) {
      throw new ForbiddenException({
        message: 'Please verify your email address to finish creating your account.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
    return { onboardingRequired: true as const, email, signupToken: await this.signupToken(email) };
  }

  private async signupToken(email: string): Promise<string> {
    const payload: SignupTokenPayload = { purpose: 'signup', email };
    return this.jwt.signAsync(payload, { expiresIn: `${SIGNUP_TOKEN_MINUTES}m` });
  }

  private async emailFromSignupToken(authorization: string | undefined): Promise<string> {
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Please verify your email address first.');
    let payload: Partial<SignupTokenPayload>;
    try {
      payload = await this.jwt.verifyAsync<Partial<SignupTokenPayload>>(token);
    } catch {
      throw new UnauthorizedException('Your sign-up session expired. Sign in with the email and password you chose to continue.');
    }
    if (payload.purpose !== 'signup' || !payload.email) {
      throw new UnauthorizedException('Please verify your email address first.');
    }
    return payload.email;
  }

  private emailIsRegistered(users: Repository<User>, email: string): Promise<boolean> {
    return users.createQueryBuilder('user').where('lower(user.email) = :email', { email }).getExists();
  }

  /** Lets the sign-up page say where to find the code when emails only go to the server log (development). */
  private deliveryHint(): 'email' | 'server-log' {
    return this.config.emailDelivery === 'log' ? 'server-log' : 'email';
  }

  private assertEmailConfigured(): void {
    if (this.config.emailDelivery === 'disabled') {
      throw new ServiceUnavailableException('Sign-up is not available yet: this server has no email service configured.');
    }
  }

  private assertCanSend(row: EmailVerification): void {
    const wait = resendWaitSeconds(row.lastSentAt);
    if (wait > 0) throw tooManyRequests(`Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code.`, wait);
  }

  private async deliver(email: string, code: string): Promise<void> {
    try {
      await this.email.send({
        to: email,
        subject: 'Your CareSlot verification code',
        text: `Your CareSlot verification code is ${code}.\n\nIt expires in ${CODE_TTL_MINUTES} minutes. If you did not try to create an account, you can ignore this email.`,
      });
    } catch (error) {
      this.logger.error(`Could not send a verification email: ${(error as Error).message}`);
      throw new ServiceUnavailableException('We could not send the verification email. Please try again in a moment.');
    }
  }
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

function tooManyRequests(message: string, retryAfterSeconds?: number): HttpException {
  return new HttpException(
    { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message, retryAfterSeconds },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** "Ananya Rao" for patients; doctors are listed as "Dr. Ananya Rao", like the rest of the directory. */
function displayName(input: ProfileInput): string {
  const full = `${input.firstName} ${input.lastName}`.replace(/\s+/g, ' ').trim();
  return input.role === 'PATIENT' ? full : withDoctorTitle(full);
}

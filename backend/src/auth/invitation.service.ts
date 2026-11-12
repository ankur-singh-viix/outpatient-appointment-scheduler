import { ConflictException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { loadConfig } from '../config.js';
import { User } from '../database/entities/index.js';
import { DeliveryError } from '../notifications/delivery-error.js';
import { EMAIL_SENDER, type EmailSender } from './email-sender.js';
import { hashPassword } from './password.js';
import { signSession } from './session.js';

/** How long an invitation link works. */
export const INVITE_HOURS = 72;
const PURPOSE = 'receptionist-invite';
const INVALID_LINK = 'This invitation link is not valid or has expired. Ask your administrator to send a new one.';

/**
 * What happened to an invitation email, said honestly:
 * - `sent`: a real email provider accepted it (so it is on its way, not necessarily delivered yet);
 * - `logged`: development only, nothing was emailed, the link was printed in the backend terminal;
 * - `failed`: it was not sent, for the (safe to show) reason given.
 * It never contains the link or the token.
 */
export interface InviteDelivery {
  status: 'sent' | 'logged' | 'failed';
  reason?: string;
}

interface InvitationPayload {
  purpose: typeof PURPOSE;
  sub: string;
}

/**
 * Invitations for accounts an administrator created: the receptionist gets a link by email and sets their own password, so no
 * password is ever chosen for them or sent to them. A link is a signed token that names the account and carries a purpose, so it
 * can never be used as a session (AuthGuard refuses any token with a purpose) and a session or sign-up token is refused here.
 * It works once: only an account that still has no password can use it, and the password is stored with a conditional update, so
 * two clicks at the same moment cannot both succeed.
 */
@Injectable()
export class InvitationService {
  private readonly logger = new Logger('Invitations');
  private readonly config = loadConfig();

  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  /** Emails a fresh link and reports what happened. A delivery problem is never thrown, so the account is still created. */
  async send(user: Pick<User, 'id' | 'name' | 'email'>, clinicName: string): Promise<InviteDelivery> {
    const payload: InvitationPayload = { purpose: PURPOSE, sub: user.id };
    const token = await this.jwt.signAsync(payload, { expiresIn: `${INVITE_HOURS}h` });
    const link = `${this.config.frontendUrl}/invite?token=${encodeURIComponent(token)}`;
    try {
      const result = await this.email.send({
        to: user.email,
        subject: 'You have been invited to the CareSlot front desk',
        text:
          `Hello ${user.name},\n\n` +
          `An administrator has set you up as a receptionist at ${clinicName}. Choose your password to get started:\n\n${link}\n\n` +
          `The link works once and expires in ${INVITE_HOURS} hours. If you were not expecting this, you can ignore this email.`,
      });
      return result?.mode === 'dev-log' ? { status: 'logged' } : { status: 'sent' };
    } catch (error) {
      // A provider's own refusal (its name and message, never a key) is worth showing; anything else gets a generic reason.
      const reason = error instanceof DeliveryError ? error.message : 'The email could not be sent.';
      this.logger.warn(`Could not send an invitation (account ${user.id}): ${reason}`);
      return { status: 'failed', reason };
    }
  }

  /** What the invitation page shows: whose account the link is for. */
  async inspect(token: string): Promise<{ name: string; email: string }> {
    const user = await this.pendingUser(token);
    return { name: user.name, email: user.email };
  }

  /** Sets the password, once, and signs the receptionist in. */
  async accept(token: string, password: string) {
    const user = await this.pendingUser(token);
    const result = await this.users.update({ id: user.id, passwordHash: IsNull() }, { passwordHash: await hashPassword(password) });
    if (!result.affected) throw new ConflictException('This invitation has already been used. Sign in with your password.');
    return signSession(this.jwt, await this.users.findOneByOrFail({ id: user.id }));
  }

  private async pendingUser(token: string): Promise<User> {
    let payload: Partial<InvitationPayload>;
    try {
      payload = await this.jwt.verifyAsync<Partial<InvitationPayload>>(token);
    } catch {
      throw new UnauthorizedException(INVALID_LINK);
    }
    if (payload.purpose !== PURPOSE || !payload.sub) throw new UnauthorizedException(INVALID_LINK);
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user || user.role !== 'RECEPTIONIST') throw new UnauthorizedException(INVALID_LINK);
    if (user.passwordHash !== null) throw new ConflictException('This invitation has already been used. Sign in with your password.');
    return user;
  }
}

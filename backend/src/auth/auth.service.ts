import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Patient, User } from '../database/entities/index.js';
import { verifyPassword } from './password.js';
import { signSession, toPublicUser, type PublicUser } from './session.js';
import { SignupService } from './signup.service.js';

export type { PublicUser } from './session.js';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Patient) private readonly patients: Repository<Patient>,
    private readonly jwt: JwtService,
    private readonly signup: SignupService,
  ) {}

  /**
   * A normal sign-in returns `{ accessToken, user }`. If the email has no account but a pending sign-up that matches
   * the password, the answer tells the client to continue the sign-up instead (see SignupService.loginPending).
   */
  async login(email: string, password: string) {
    const user = await this.users
      .createQueryBuilder('user')
      .where('lower(user.email) = lower(:email)', { email: email.trim() })
      .getOne();
    if (!user) return this.signup.loginPending(email, password);
    // Same message for unknown email and wrong password, so emails can't be probed.
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Incorrect email or password.');
    }
    return signSession(this.jwt, user);
  }

  /** The signed-in patient's own details, for the My Profile page. Null fields are ones they never gave. */
  async patientProfile(userId: string) {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found.');
    const patient = await this.patients.findOneBy({ userId });
    return {
      name: user.name,
      email: user.email,
      memberSince: user.createdAt,
      phone: patient?.phone ?? null,
      dateOfBirth: patient?.dateOfBirth ?? null,
      gender: patient?.gender ?? null,
      address: patient?.address ?? null,
    };
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found.');
    return toPublicUser(user);
  }
}

import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../database/entities/index.js';
import type { JwtPayload, Role } from './auth.types.js';
import { verifyPassword } from './password.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<{ accessToken: string; user: PublicUser }> {
    const user = await this.users
      .createQueryBuilder('user')
      .where('lower(user.email) = lower(:email)', { email: email.trim() })
      .getOne();
    // Same message for unknown email and wrong password, so emails can't be probed.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Incorrect email or password.');
    }
    const payload: JwtPayload = { sub: user.id, name: user.name, role: user.role };
    return { accessToken: await this.jwt.signAsync(payload), user: toPublicUser(user) };
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found.');
    return toPublicUser(user);
  }
}

function toPublicUser(user: User): PublicUser {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

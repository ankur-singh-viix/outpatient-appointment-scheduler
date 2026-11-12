import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ExternalIdentity } from '../database/entities/index.js';
import type { AuthUser } from './auth.types.js';

export const CLERK_PROVIDER = 'clerk';

/** Finds the CareSlot user behind an outside sign-in. The user's role always comes from our own users table. */
@Injectable()
export class IdentityService {
  constructor(@InjectRepository(ExternalIdentity) private readonly identities: Repository<ExternalIdentity>) {}

  async findUserByClerkId(clerkUserId: string): Promise<AuthUser | null> {
    try {
      const link = await this.identities.findOne({
        where: { provider: CLERK_PROVIDER, externalId: clerkUserId },
        relations: { user: true },
      });
      return link ? { id: link.user.id, name: link.user.name, role: link.user.role } : null;
    } catch (error) {
      // Migration 005 has not been applied yet: say so plainly instead of failing with a database error.
      if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '42P01') {
        throw new ServiceUnavailableException('Clerk sign-in is not ready on this server: database migration 005 has not been applied.');
      }
      throw error;
    }
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { InvitationService } from '../auth/invitation.service.js';
import { loadConfig, usesResendTestingSender } from '../config.js';
import { Clinic, ReceptionistAssignment, User } from '../database/entities/index.js';
import { isUniqueViolation } from '../database/errors.js';

const NO_CLINIC = 'clinicId: choose one of the listed clinics.';

function view(user: User, clinic: Clinic | null) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    clinic: clinic ? { id: clinic.id, name: clinic.name } : null,
    /** True until the receptionist has set their own password from the emailed link. */
    invitePending: user.passwordHash === null,
  };
}

/**
 * Receptionist accounts, created and assigned by an administrator only. The role is fixed here (never taken from the request),
 * every receptionist has exactly one clinic, and no password is ever chosen for them: they set it from an emailed link.
 * The clinic is what the receptionist API then checks on every request, so reassigning it changes what they can see at once.
 */
@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Clinic) private readonly clinics: Repository<Clinic>,
    @InjectRepository(ReceptionistAssignment) private readonly assignments: Repository<ReceptionistAssignment>,
    private readonly dataSource: DataSource,
    private readonly invitations: InvitationService,
  ) {}

  async listReceptionists() {
    const rows = await this.users.find({ where: { role: 'RECEPTIONIST' }, order: { name: 'ASC' } });
    if (rows.length === 0) return [];
    const links = await this.assignments.find({ where: { receptionistUserId: In(rows.map((row) => row.id)) }, relations: { clinic: true } });
    return rows.map((row) => view(row, links.find((link) => link.receptionistUserId === row.id)?.clinic ?? null));
  }

  async createReceptionist(input: { name: string; email: string; clinicId: string }) {
    const email = input.email.trim().toLowerCase();
    const clinic = await this.clinics.findOneBy({ id: input.clinicId });
    if (!clinic) throw new BadRequestException(NO_CLINIC);
    if (await this.users.createQueryBuilder('user').where('lower(user.email) = :email', { email }).getExists()) {
      throw new ConflictException('An account with this email already exists.');
    }
    let user: User;
    try {
      user = await this.dataSource.transaction(async (manager) => {
        const created = await manager.save(manager.create(User, { name: input.name.trim(), email, passwordHash: null, googleId: null, role: 'RECEPTIONIST' }));
        await manager.save(manager.create(ReceptionistAssignment, { receptionistUserId: created.id, clinicId: clinic.id }));
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('An account with this email already exists.');
      throw error;
    }
    const invite = await this.invitations.send(user, clinic.name);
    return { ...view(user, clinic), invite };
  }

  /** Sends a new link to a receptionist who has not set a password yet. */
  async resendInvitation(id: string) {
    const user = await this.receptionist(id);
    if (user.passwordHash !== null) throw new ConflictException('This receptionist has already set a password.');
    const clinic = await this.clinicOf(user.id);
    const invite = await this.invitations.send(user, clinic?.name ?? 'your clinic');
    return { ...view(user, clinic), invite };
  }

  /**
   * How email will be delivered right now, so the page can say so before anyone is invited. `provider` means a real email provider
   * (and `testingSender` that it is Resend's shared sender, which only reaches the account owner); `dev-log` means development,
   * where nothing is emailed; `disabled` means email is not configured, with the (secret-free) reason.
   */
  emailStatus() {
    const config = loadConfig();
    return {
      mode: config.emailDelivery === 'resend' || config.emailDelivery === 'brevo' ? ('provider' as const) : config.emailDelivery === 'log' ? ('dev-log' as const) : ('disabled' as const),
      testingSender: config.emailDelivery === 'resend' && usesResendTestingSender(config.emailFrom),
      problem: config.emailProblem,
    };
  }

  /** Moves a receptionist to another clinic: their old access ends and the new one starts in the same transaction. */
  async setClinic(id: string, clinicId: string) {
    const user = await this.receptionist(id);
    const clinic = await this.clinics.findOneBy({ id: clinicId });
    if (!clinic) throw new BadRequestException(NO_CLINIC);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(ReceptionistAssignment, { receptionistUserId: user.id });
      await manager.save(manager.create(ReceptionistAssignment, { receptionistUserId: user.id, clinicId: clinic.id }));
    });
    return view(user, clinic);
  }

  private async receptionist(id: string): Promise<User> {
    const user = await this.users.findOneBy({ id, role: 'RECEPTIONIST' });
    if (!user) throw new NotFoundException('Receptionist not found.');
    return user;
  }

  private async clinicOf(userId: string): Promise<Clinic | null> {
    const link = await this.assignments.findOne({ where: { receptionistUserId: userId }, relations: { clinic: true } });
    return link?.clinic ?? null;
  }
}

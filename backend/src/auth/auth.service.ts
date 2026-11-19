import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Patient, PatientMedicalProfileHistory, User } from '../database/entities/index.js';
import { verifyPassword } from './password.js';
import { medicalProfileChanges, type MedicalValues } from './medical-profile-diff.js';
import type { BloodGroup } from './patient-uhid.js';
import { signSession, toPublicUser, type PublicUser } from './session.js';
import { SignupService } from './signup.service.js';

export type { PublicUser } from './session.js';

export type MedicalProfileUpdate = Partial<MedicalValues> & {
  bloodGroup?: BloodGroup | null;
};

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Patient) private readonly patients: Repository<Patient>,
    private readonly dataSource: DataSource,
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

  /** The signed-in patient's own details (identity + medical profile). Never another patient's. */
  async patientProfile(userId: string) {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found.');
    const patient = await this.patients.findOneBy({ userId });
    if (!patient) throw new NotFoundException('Patient profile not found.');
    return this.toPatientProfile(user, patient);
  }

  /**
   * Updates medical fields on the signed-in patient's own profile and appends history rows.
   * Locks the patient row for the duration of the write so concurrent updates serialize cleanly.
   * Does not change UHID, phone uniqueness rules, or account identity.
   */
  async updatePatientMedicalProfile(userId: string, input: MedicalProfileUpdate) {
    const user = await this.users.findOneBy({ id: userId });
    if (!user || user.role !== 'PATIENT') throw new ForbiddenException('Only patients can update a medical profile.');

    return this.dataSource.transaction(async (manager) => {
      const patient = await manager.getRepository(Patient).findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!patient) throw new NotFoundException('Patient profile not found.');

      const current: MedicalValues = {
        bloodGroup: patient.bloodGroup,
        allergies: patient.allergies,
        sensitivities: patient.sensitivities,
        medicalConditions: patient.medicalConditions,
        currentMedications: patient.currentMedications,
        previousSurgeries: patient.previousSurgeries,
        otherMedicalInfo: patient.otherMedicalInfo,
      };
      const changes = medicalProfileChanges(current, input);
      if (changes.length === 0) return this.toPatientProfile(user, patient);

      for (const change of changes) {
        patient[change.fieldName] = change.newValue;
      }

      await manager.save(Patient, patient);
      await manager.save(
        changes.map((change) =>
          manager.create(PatientMedicalProfileHistory, {
            patientId: patient.id,
            fieldName: change.fieldName,
            previousValue: change.previousValue,
            newValue: change.newValue,
            updatedByUserId: userId,
          }),
        ),
      );

      return this.toPatientProfile(user, patient);
    });
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found.');
    return toPublicUser(user);
  }

  private toPatientProfile(user: User, patient: Patient) {
    return {
      patientId: patient.id,
      uhid: patient.uhid,
      name: user.name,
      email: user.email,
      memberSince: user.createdAt,
      phone: patient.phone ?? null,
      dateOfBirth: patient.dateOfBirth ?? null,
      gender: patient.gender ?? null,
      address: patient.address ?? null,
      bloodGroup: patient.bloodGroup ?? null,
      allergies: patient.allergies ?? null,
      sensitivities: patient.sensitivities ?? null,
      medicalConditions: patient.medicalConditions ?? null,
      currentMedications: patient.currentMedications ?? null,
      previousSurgeries: patient.previousSurgeries ?? null,
      otherMedicalInfo: patient.otherMedicalInfo ?? null,
    };
  }
}

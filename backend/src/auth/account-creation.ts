import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { withDoctorTitle } from '../common/names.js';
import { Clinic, Doctor, Patient, Specialty, User } from '../database/entities/index.js';

/**
 * What a visitor fills in to finish creating an account. Only PATIENT and DOCTOR can be chosen here: receptionist and
 * admin accounts are never self-service and never come from the browser.
 */
export type ProfileInput =
  | { role: 'PATIENT'; firstName: string; lastName: string; phone?: string; dateOfBirth?: string; gender?: string }
  | { role: 'DOCTOR'; firstName: string; lastName: string; specialtyId: string; clinicId: string; consultationFee: number; bio?: string };

/** "Ananya Rao" for patients; doctors are listed as "Dr. Ananya Rao", like the rest of the directory. */
export function displayName(input: ProfileInput): string {
  const full = `${input.firstName} ${input.lastName}`.replace(/\s+/g, ' ').trim();
  return input.role === 'PATIENT' ? full : withDoctorTitle(full);
}

/**
 * Creates the user and their patient or doctor row inside the caller's transaction. `passwordHash` is null for people who
 * sign in through an outside provider and so have no CareSlot password. The caller checks that the email is free.
 */
export async function createAccount(
  manager: EntityManager,
  args: { email: string; passwordHash: string | null; input: ProfileInput },
): Promise<User> {
  const { email, passwordHash, input } = args;

  if (input.role === 'DOCTOR') {
    if (!(await manager.existsBy(Specialty, { id: input.specialtyId }))) {
      throw new BadRequestException('specialtyId: choose one of the listed specialties.');
    }
    if (!(await manager.existsBy(Clinic, { id: input.clinicId }))) {
      throw new BadRequestException('clinicId: choose one of the listed clinics.');
    }
  }

  const created = await manager.save(
    manager.create(User, { name: displayName(input), email, passwordHash, googleId: null, role: input.role }),
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
  return created;
}

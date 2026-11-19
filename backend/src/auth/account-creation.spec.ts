import { displayName, type ProfileInput } from './account-creation.js';

describe('account-creation displayName', () => {
  it('titles doctors and leaves patients and receptionists untitled', () => {
    const patient: ProfileInput = { role: 'PATIENT', firstName: 'Ananya', lastName: 'Rao' };
    const doctor: ProfileInput = {
      role: 'DOCTOR',
      firstName: 'Ananya',
      lastName: 'Rao',
      specialtyId: '00000000-0000-4000-8000-000000000001',
      clinicId: '00000000-0000-4000-8000-000000000002',
      consultationFee: 500,
    };
    const receptionist: ProfileInput = { role: 'RECEPTIONIST', firstName: 'Rita', lastName: 'Desk' };
    expect(displayName(patient)).toBe('Ananya Rao');
    expect(displayName(doctor)).toMatch(/^Dr\./);
    expect(displayName(receptionist)).toBe('Rita Desk');
  });
});

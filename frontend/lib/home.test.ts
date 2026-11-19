import { describe, expect, it } from 'vitest';
import { homeFor } from './home';

describe('homeFor', () => {
  it('sends each role to its own workspace after sign-in', () => {
    expect(homeFor('PATIENT')).toBe('/dashboard');
    expect(homeFor('DOCTOR')).toBe('/doctor');
    expect(homeFor('RECEPTIONIST')).toBe('/reception');
    expect(homeFor('ADMIN')).toBe('/admin/receptionists');
  });
});

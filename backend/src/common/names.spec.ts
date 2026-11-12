import { withDoctorTitle } from './names.js';

describe('withDoctorTitle', () => {
  it('adds the title to a plain name', () => {
    expect(withDoctorTitle('Meera Shah')).toBe('Dr. Meera Shah');
  });

  it('does not double the title, however it was typed', () => {
    expect(withDoctorTitle('Dr. Meera Shah')).toBe('Dr. Meera Shah');
    expect(withDoctorTitle('dr meera shah')).toBe('dr meera shah');
    expect(withDoctorTitle('DR. Meera Shah')).toBe('DR. Meera Shah');
  });

  it('tidies stray spaces', () => {
    expect(withDoctorTitle('  Meera   Shah ')).toBe('Dr. Meera Shah');
  });

  it('does not treat a name that merely starts with "dr" as a title', () => {
    expect(withDoctorTitle('Drake Ramoray')).toBe('Dr. Drake Ramoray');
  });
});

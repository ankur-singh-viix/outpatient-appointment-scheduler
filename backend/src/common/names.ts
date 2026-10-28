/** Doctors are listed as "Dr. Ananya Rao". Adds the title unless the name already starts with it. */
export function withDoctorTitle(name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  return /^dr\.?\s/i.test(clean) ? clean : `Dr. ${clean}`;
}

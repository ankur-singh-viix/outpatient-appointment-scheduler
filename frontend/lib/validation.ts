// Friendly client-side checks for the sign-up forms. The server validates everything again (it is the real gatekeeper);
// these only give immediate, specific messages next to the field.

export type Errors = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]{6,19}$/;

export function validateAccount(values: { email: string; password: string }): Errors {
  const errors: Errors = {};
  if (!values.email.trim()) errors.email = 'Enter your email address.';
  else if (!EMAIL.test(values.email.trim())) errors.email = 'Enter a valid email address, like name@example.com.';
  if (!values.password) errors.password = 'Choose a password.';
  else if (values.password.length < 8) errors.password = 'Use at least 8 characters.';
  return errors;
}

function validateNames(values: { firstName: string; lastName: string }): Errors {
  const errors: Errors = {};
  if (!values.firstName.trim()) errors.firstName = 'Enter your first name.';
  else if (values.firstName.trim().length > 50) errors.firstName = 'Use 50 characters or fewer.';
  if (!values.lastName.trim()) errors.lastName = 'Enter your last name.';
  else if (values.lastName.trim().length > 50) errors.lastName = 'Use 50 characters or fewer.';
  return errors;
}

export function validatePatient(
  values: { firstName: string; lastName: string; phone: string; dateOfBirth: string },
  today: string | null,
): Errors {
  const errors = validateNames(values);
  if (values.phone.trim() && !PHONE.test(values.phone.trim())) errors.phone = 'Enter a valid phone number, like +91 98765 43210.';
  if (values.dateOfBirth) {
    if (values.dateOfBirth < '1900-01-01') errors.dateOfBirth = 'Enter a real date of birth.';
    else if (today && values.dateOfBirth > today) errors.dateOfBirth = 'Date of birth cannot be in the future.';
  }
  return errors;
}

export function validateDoctor(values: {
  firstName: string;
  lastName: string;
  specialtyId: string;
  clinicId: string;
  fee: string;
  bio: string;
}): Errors {
  const errors = validateNames(values);
  if (!values.specialtyId) errors.specialtyId = 'Choose your specialty.';
  if (!values.clinicId) errors.clinicId = 'Choose the clinic where you consult.';
  if (values.fee.trim() === '') errors.fee = 'Enter your consultation fee (0 if free).';
  else if (!/^\d+$/.test(values.fee.trim())) errors.fee = 'Use whole rupees only, with no symbols.';
  else if (Number(values.fee) > 100000) errors.fee = 'That fee looks too high. Use ₹100,000 or less.';
  if (values.bio.length > 1000) errors.bio = 'Keep your bio to 1000 characters or fewer.';
  return errors;
}

/** The errors without one field, used to clear a message as soon as the person edits that field. */
export function without(errors: Errors, key: string): Errors {
  return Object.fromEntries(Object.entries(errors).filter(([name]) => name !== key));
}

/** Turns the server's "field: message" strings into messages keyed by field name. */
export function fieldErrorsFromApi(details: string[]): Errors {
  const errors: Errors = {};
  for (const detail of details) {
    const match = /^(\w+): (.+)$/.exec(detail);
    if (!match) continue;
    const [, field, message] = match;
    errors[field] ??= message.charAt(0).toUpperCase() + message.slice(1) + (message.endsWith('.') ? '' : '.');
  }
  return errors;
}

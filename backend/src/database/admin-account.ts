import type pg from 'pg';
import { hashPassword } from '../auth/password.js';

export const MIN_ADMIN_PASSWORD = 12;

/**
 * Creates an administrator account. Administrators are never created through the website: the person running the server does it
 * from a terminal. An email that already has an account is refused rather than upgraded, so a patient or doctor can never be
 * turned into an administrator by accident.
 */
export async function createAdminAccount(client: pg.Client, args: { name: string; email: string; password: string }): Promise<'created' | 'exists'> {
  const name = args.name.trim();
  const email = args.email.trim().toLowerCase();
  if (name.length < 2 || name.length > 100) throw new Error('The name must be 2 to 100 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That is not a valid email address.');
  if (args.password.length < MIN_ADMIN_PASSWORD) throw new Error(`The password must be at least ${MIN_ADMIN_PASSWORD} characters.`);
  const { rowCount } = await client.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'ADMIN') ON CONFLICT (email) DO NOTHING`,
    [name, email, await hashPassword(args.password)],
  );
  return rowCount === 1 ? 'created' : 'exists';
}

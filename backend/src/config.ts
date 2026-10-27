import { existsSync } from 'node:fs';

export interface AppConfig {
  databaseUrl: string;
  jwtSecret: string;
  corsOrigins: string[];
  /** IANA zone of the clinics; decides what "today" and "now" mean for slots. */
  clinicTimezone: string;
  /** How many days ahead patients may book. */
  bookingWindowDays: number;
}

const DEV_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/outpatient';

/** Loads backend/.env for local runs. Hosted environments set real variables instead. */
export function loadEnvFileIfPresent(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(): AppConfig {
  // Railway sets RAILWAY_ENVIRONMENT_NAME; NODE_ENV is often left unset there so devDependencies install for the build.
  const production = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
  const required = (name: string, devDefault: string): string => {
    const value = process.env[name];
    if (value) return value;
    if (production) throw new Error(`Missing required environment variable ${name}`);
    return devDefault;
  };

  return {
    databaseUrl: required('DATABASE_URL', DEV_DATABASE_URL),
    jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me'),
    corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:3001')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    clinicTimezone: process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata',
    bookingWindowDays: Number(process.env.BOOKING_WINDOW_DAYS ?? 30),
  };
}

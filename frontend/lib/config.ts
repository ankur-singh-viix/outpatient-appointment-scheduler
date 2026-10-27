/** Base URL of the NestJS API, including the /api prefix. Inlined at build time. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api').replace(/\/$/, '');

/** Time zone the clinics operate in. Must match the backend's CLINIC_TIMEZONE. */
export const CLINIC_TIMEZONE = process.env.NEXT_PUBLIC_CLINIC_TIMEZONE ?? 'Asia/Kolkata';

/** Number of upcoming days offered in the date picker. */
export const BOOKING_DAYS_SHOWN = 14;

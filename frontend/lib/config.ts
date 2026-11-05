const apiUrl =
  process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000/api');

// A production build without this variable would silently call localhost from every visitor's browser. Fail the build instead.
if (!apiUrl || !/^https?:\/\//.test(apiUrl)) {
  throw new Error(
    'NEXT_PUBLIC_API_URL must be set to the backend URL including /api, e.g. https://your-api.onrender.com/api',
  );
}

/** Base URL of the NestJS API, including the /api prefix. Inlined at build time. */
export const API_URL = apiUrl.replace(/\/$/, '');

/** Time zone the clinics operate in. Must match the backend's CLINIC_TIMEZONE. */
export const CLINIC_TIMEZONE = process.env.NEXT_PUBLIC_CLINIC_TIMEZONE ?? 'Asia/Kolkata';

/** Number of upcoming days offered in the date picker. */
export const BOOKING_DAYS_SHOWN = 14;

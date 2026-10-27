import { z } from 'zod';
import { DATE_PATTERN, TIME_PATTERN } from './calendar.js';

// Shared field schemas. Calendar-validity of dates (e.g. 2026-02-30) is checked again in the services.
export const dateSchema = z.string().regex(DATE_PATTERN, 'must be in YYYY-MM-DD format');
export const timeSchema = z.string().regex(TIME_PATTERN, 'must be in HH:MM format');

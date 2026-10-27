// Shapes returned by the backend API.

export type Role = 'PATIENT' | 'DOCTOR' | 'RECEPTIONIST' | 'ADMIN';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface Session {
  accessToken: string;
  user: PublicUser;
}

export interface Specialty {
  id: string;
  name: string;
}

export interface WeeklyWindow {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface Doctor {
  id: string;
  name: string;
  bio: string | null;
  consultationFee: number;
  consultationMinutes: number;
  specialty: Specialty;
  clinic: { name: string; address: string };
  weeklyHours: WeeklyWindow[];
}

export type SlotStatus = 'AVAILABLE' | 'BOOKED' | 'FULL' | 'PAST';

export interface Slot {
  startTime: string;
  endTime: string;
  status: SlotStatus;
}

export interface SessionSummary {
  startTime: string;
  endTime: string;
  capacity: number;
  booked: number;
  remaining: number;
  source: 'OVERRIDE' | 'WEEKLY';
}

export interface DaySchedule {
  doctorId: string;
  date: string;
  consultationMinutes: number;
  unavailableReason: string | null;
  sessions: SessionSummary[];
  slots: Slot[];
}

export type AppointmentStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

export interface PatientAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  createdAt: string;
  doctor: { id: string; name: string; specialty: string; consultationFee: number };
  clinic: { name: string; address: string };
}

export interface DoctorAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  bookedAt: string;
  patient: { name: string; phone: string | null };
}

export interface WeeklyHours {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  capacity: number;
}

export interface DateOverride {
  date: string;
  isAvailable: boolean;
  startTime: string | null;
  endTime: string | null;
  capacity: number | null;
  reason: string | null;
}

export interface DoctorAvailability {
  consultationMinutes: number;
  defaultCapacity: number;
  weekly: WeeklyHours[];
  overrides: DateOverride[];
}

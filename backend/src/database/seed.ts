// CLI: `npm run db:seed`. Adds demo clinics, doctors, patients and weekly hours.
// Safe to run repeatedly: it only inserts what is missing and never touches a doctor
// who already has weekly hours, so edits made in the app survive re-seeding.
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { loadConfig, loadEnvFileIfPresent } from '../config.js';

const DEMO_PASSWORD = 'Demo@1234';

const SPECIALTIES = [
  ['General Physician', 'Fever, infections, routine check-ups and chronic care.'],
  ['Cardiology', 'Heart and blood-vessel conditions.'],
  ['Dermatology', 'Skin, hair and nail conditions.'],
  ['Orthopedics', 'Bones, joints and sports injuries.'],
  ['Pediatrics', 'Healthcare for infants, children and teenagers.'],
  ['ENT', 'Ear, nose and throat conditions.'],
] as const;

const CLINICS = [
  ['CityCare Clinic', '12 Residency Road, Bengaluru 560025', '+91 80 4000 1000'],
  ['Sunrise Health Centre', '5 Link Road, Andheri West, Mumbai 400053', '+91 22 4000 2000'],
] as const;

const MON_FRI = [1, 2, 3, 4, 5];
const MON_SAT = [1, 2, 3, 4, 5, 6];

type Session = { days: number[]; start: string; end: string; capacity: number };

const DOCTORS: {
  name: string;
  email: string;
  specialty: string;
  clinic: string;
  fee: number;
  minutes: number;
  bio: string;
  sessions: Session[];
}[] = [
  {
    name: 'Dr. Ananya Rao',
    email: 'ananya.rao@example.com',
    specialty: 'General Physician',
    clinic: 'CityCare Clinic',
    fee: 500,
    minutes: 15,
    bio: 'MBBS, MD (Internal Medicine). 12 years of experience in family medicine.',
    sessions: [
      { days: MON_FRI, start: '09:00', end: '13:00', capacity: 12 },
      { days: MON_FRI, start: '17:00', end: '19:00', capacity: 6 },
    ],
  },
  {
    name: 'Dr. Vikram Mehta',
    email: 'vikram.mehta@example.com',
    specialty: 'Cardiology',
    clinic: 'CityCare Clinic',
    fee: 1200,
    minutes: 20,
    bio: 'MD, DM (Cardiology). Focus on preventive cardiology and hypertension.',
    sessions: [{ days: [1, 3, 5], start: '10:00', end: '14:00', capacity: 10 }],
  },
  {
    name: 'Dr. Priya Nair',
    email: 'priya.nair@example.com',
    specialty: 'Dermatology',
    clinic: 'Sunrise Health Centre',
    fee: 800,
    minutes: 15,
    bio: 'MD (Dermatology). Acne, eczema, hair loss and cosmetic dermatology.',
    sessions: [{ days: MON_SAT, start: '11:00', end: '15:00', capacity: 14 }],
  },
  {
    name: 'Dr. Arjun Kapoor',
    email: 'arjun.kapoor@example.com',
    specialty: 'Orthopedics',
    clinic: 'Sunrise Health Centre',
    fee: 1000,
    minutes: 20,
    bio: 'MS (Orthopedics). Joint pain, fractures and sports injuries.',
    sessions: [{ days: [2, 4, 6], start: '09:30', end: '12:30', capacity: 8 }],
  },
  {
    name: 'Dr. Meera Iyer',
    email: 'meera.iyer@example.com',
    specialty: 'Pediatrics',
    clinic: 'CityCare Clinic',
    fee: 700,
    minutes: 15,
    bio: 'MD (Pediatrics). Newborn care, vaccinations and child development.',
    sessions: [{ days: MON_SAT, start: '09:00', end: '12:00', capacity: 12 }],
  },
  {
    // Deliberately small capacity (3 bookings for 8 slots) to demonstrate capacity limits.
    name: 'Dr. Rohan Das',
    email: 'rohan.das@example.com',
    specialty: 'ENT',
    clinic: 'Sunrise Health Centre',
    fee: 600,
    minutes: 15,
    bio: 'MS (ENT). Sinus problems, hearing issues and throat infections.',
    sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '12:00', capacity: 3 }],
  },
];

const PATIENTS = [
  { name: 'Rahul Sharma', email: 'patient@example.com', phone: '+91 98000 11111', gender: 'Male', dob: '1992-04-18' },
  { name: 'Sneha Gupta', email: 'sneha.gupta@example.com', phone: '+91 98000 22222', gender: 'Female', dob: '1988-11-02' },
];

async function upsertUser(client: pg.Client, name: string, email: string, role: string, passwordHash: string) {
  await client.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING`,
    [name, email, passwordHash, role],
  );
  const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  return rows[0].id;
}

async function seedDemoData(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await hashPassword(DEMO_PASSWORD);

    for (const [name, description] of SPECIALTIES) {
      await client.query(
        'INSERT INTO specialties (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        [name, description],
      );
    }
    for (const [name, address, phone] of CLINICS) {
      await client.query(
        `INSERT INTO clinics (name, address, phone)
         SELECT $1::varchar, $2::text, $3::varchar WHERE NOT EXISTS (SELECT 1 FROM clinics WHERE name = $1::varchar)`,
        [name, address, phone],
      );
    }

    for (const doctor of DOCTORS) {
      const userId = await upsertUser(client, doctor.name, doctor.email, 'DOCTOR', passwordHash);
      // RETURNING is empty when the doctor already exists, so existing doctors and any hours they edited are never touched.
      const created = await client.query<{ id: string }>(
        `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee, bio)
         VALUES ($1, (SELECT id FROM clinics WHERE name = $2 LIMIT 1), (SELECT id FROM specialties WHERE name = $3),
                 $4, 20, $5, $6)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING id`,
        [userId, doctor.clinic, doctor.specialty, doctor.minutes, doctor.fee, doctor.bio],
      );
      if (created.rows.length === 0) continue;
      for (const session of doctor.sessions) {
        for (const day of session.days) {
          await client.query(
            `INSERT INTO availability (doctor_id, day_of_week, start_time, end_time, capacity)
             VALUES ($1, $2, $3, $4, $5)`,
            [created.rows[0].id, day, session.start, session.end, session.capacity],
          );
        }
      }
    }

    for (const patient of PATIENTS) {
      const userId = await upsertUser(client, patient.name, patient.email, 'PATIENT', passwordHash);
      await client.query(
        `INSERT INTO patients (user_id, phone, gender, date_of_birth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, patient.phone, patient.gender, patient.dob],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

loadEnvFileIfPresent();
if (process.env.SKIP_DEMO_SEED === 'true') {
  console.log('SKIP_DEMO_SEED=true: not adding demo data.');
} else {
  await seedDemoData(loadConfig().databaseUrl);
  console.log(`Demo data ready. All demo accounts use the password: ${DEMO_PASSWORD}`);
}

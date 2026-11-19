import { missingColumns, missingSchemaGuards, missingTables } from './schema-guards.js';

const fake = (constraints: string[], indexes: string[]) => ({
  query: async (sql: string) => (sql.includes('pg_constraint') ? constraints.map((conname) => ({ conname })) : indexes.map((indexname) => ({ indexname }))),
});
const ALL_CONSTRAINTS = ['ck_appointment_seat', 'ck_appointment_cancelled_by', 'ex_appointments_no_overlap'];

describe('missingSchemaGuards', () => {
  it('reports nothing when every protection is present', async () => {
    expect(await missingSchemaGuards(fake(ALL_CONSTRAINTS, ['uq_active_slot_seat']))).toEqual([]);
  });

  it('names the overlap guard when migration 007 could not add it, and says what that means', async () => {
    const missing = await missingSchemaGuards(fake(ALL_CONSTRAINTS.filter((name) => name !== 'ex_appointments_no_overlap'), ['uq_active_slot_seat']));
    expect(missing).toEqual([{ name: 'ex_appointments_no_overlap', consequence: expect.stringContaining('booking code only') }]);
  });

  it('reports a missing seat index and a missing check', async () => {
    const missing = await missingSchemaGuards(fake(['ex_appointments_no_overlap', 'ck_appointment_cancelled_by'], []));
    expect(missing.map((guard) => guard.name).sort((x, y) => x.localeCompare(y))).toEqual(['ck_appointment_seat', 'uq_active_slot_seat']);
  });
});

describe('missingTables', () => {
  const answering = (found: string | null) => ({ query: async () => [{ found }] });
  it('reports the assistant table when migration 012 has not been applied, and says what stops working', async () => {
    const missing = await missingTables(answering(null));
    expect(missing.map((row) => row.name)).toEqual([
      'assistant_actions',
      'assistant_conversations',
      'queue_entries',
      'doctor_receptionist_assignments',
      'prescriptions',
      'patient_medical_profile_history',
      'patient_medical_reports',
    ]);
    expect(missing[0]).toEqual(expect.objectContaining({ migration: '012_assistant_actions.sql' }));
    expect(missing[0].consequence).toMatch(/cannot prepare bookings/);
  });
  it('reports the history table when migration 013 has not been applied, and says the assistant still answers', async () => {
    const onlyActions = {
      query: async (sql: string) => [
        {
          found:
            sql.includes('assistant_actions') ||
            sql.includes('queue_entries') ||
            sql.includes('doctor_receptionist') ||
            sql.includes('prescriptions') ||
            sql.includes('patient_medical_profile_history') ||
            sql.includes('patient_medical_reports')
              ? 'present'
              : null,
        },
      ],
    };
    const missing = await missingTables(onlyActions);
    expect(missing).toEqual([expect.objectContaining({ name: 'assistant_conversations', migration: '013_assistant_history.sql' })]);
    expect(missing[0].consequence).toMatch(/still answers/);
  });
  it('reports the queue table when migration 015 has not been applied, and says everything else keeps working', async () => {
    const withoutQueue = { query: async (sql: string) => [{ found: sql.includes('queue_entries') ? null : 'present' }] };
    const missing = await missingTables(withoutQueue);
    expect(missing).toEqual([expect.objectContaining({ name: 'queue_entries', migration: '015_queue_management.sql' })]);
    expect(missing[0].consequence).toMatch(/keep working/);
  });
  it('reports doctor receptionist and prescription tables when migration 016 has not been applied', async () => {
    const without016 = {
      query: async (sql: string) => [
        { found: sql.includes('doctor_receptionist') || sql.includes('prescriptions') ? null : 'present' },
      ],
    };
    const missing = await missingTables(without016);
    expect(missing.map((row) => row.name)).toEqual(['doctor_receptionist_assignments', 'prescriptions']);
  });
  it('reports nothing when the tables are there', async () => {
    expect(await missingTables(answering('assistant_actions'))).toEqual([]);
  });
});

describe('missingColumns', () => {
  it('reports the hide-from-history column when migration 014 has not been applied, and says only that feature is affected', async () => {
    const missing = await missingColumns({
      query: async (sql: string) => (sql.includes('hidden_by_patient_at') ? [] : [{ is_nullable: 'YES' }]),
    });
    expect(missing).toEqual([expect.objectContaining({ table: 'appointments', column: 'hidden_by_patient_at', migration: '014_hide_appointments_from_history.sql' })]);
    expect(missing[0].consequence).toMatch(/everything else keeps working/);
  });

  it('reports queue checked_in_at when migration 017 has not made it nullable', async () => {
    const missing = await missingColumns({
      query: async (sql: string) => {
        if (sql.includes('hidden_by_patient_at') || sql.includes("'uhid'")) return [{ is_nullable: 'YES' }];
        if (sql.includes('checked_in_at')) return [{ is_nullable: 'NO' }];
        return [{ is_nullable: 'YES' }];
      },
    });
    expect(missing).toEqual([
      expect.objectContaining({
        table: 'queue_entries',
        column: 'checked_in_at',
        migration: '017_booking_time_queue_tokens.sql',
      }),
    ]);
    expect(missing[0].consequence).toMatch(/booking-time queue tokens fail/);
  });

  it('reports patients.uhid when migration 018 has not been applied', async () => {
    const missing = await missingColumns({
      query: async (sql: string) => (sql.includes("'uhid'") ? [] : [{ is_nullable: 'YES' }]),
    });
    expect(missing).toEqual([expect.objectContaining({ table: 'patients', column: 'uhid', migration: '018_patient_uhid_and_medical_profile.sql' })]);
  });

  it('reports nothing when required columns exist and nullable ones allow NULL', async () => {
    expect(await missingColumns({ query: async () => [{ is_nullable: 'YES' }] })).toEqual([]);
  });
});

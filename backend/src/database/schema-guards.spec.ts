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
    expect(missing).toEqual([
      expect.objectContaining({ name: 'assistant_actions', migration: '012_assistant_actions.sql' }),
      expect.objectContaining({ name: 'assistant_conversations', migration: '013_assistant_history.sql' }),
    ]);
    expect(missing[0].consequence).toMatch(/cannot prepare bookings/);
  });
  it('reports the history table when migration 013 has not been applied, and says the assistant still answers', async () => {
    const onlyActions = { query: async (sql: string) => [{ found: sql.includes('assistant_actions') ? 'assistant_actions' : null }] };
    const missing = await missingTables(onlyActions);
    expect(missing).toEqual([expect.objectContaining({ name: 'assistant_conversations', migration: '013_assistant_history.sql' })]);
    expect(missing[0].consequence).toMatch(/still answers/);
  });
  it('reports nothing when the tables are there', async () => {
    expect(await missingTables(answering('assistant_actions'))).toEqual([]);
  });
});

describe('missingColumns', () => {
  it('reports the hide-from-history column when migration 014 has not been applied, and says only that feature is affected', async () => {
    const missing = await missingColumns({ query: async () => [] });
    expect(missing).toEqual([expect.objectContaining({ table: 'appointments', column: 'hidden_by_patient_at', migration: '014_hide_appointments_from_history.sql' })]);
    expect(missing[0].consequence).toMatch(/everything else keeps working/);
  });
  it('reports nothing when the column is there', async () => {
    expect(await missingColumns({ query: async () => [{ found: 1 }] })).toEqual([]);
  });
});

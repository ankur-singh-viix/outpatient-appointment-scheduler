import { missingSchemaGuards } from './schema-guards.js';

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

/** Anything that can run a query: the application's DataSource, or a stand-in in a test. */
export interface Queryable {
  query: (sql: string) => Promise<unknown>;
}

export interface MissingGuard {
  name: string;
  /** What can go wrong without it, in plain words. */
  consequence: string;
}

/** The database-level protections for appointments. The booking code enforces the same rules under the doctor lock; these make them hold even if something else writes. */
const GUARDS: { name: string; kind: 'constraint' | 'index'; consequence: string }[] = [
  { name: 'uq_active_slot_seat', kind: 'index', consequence: 'two active appointments could share one seat of a slot' },
  { name: 'ck_appointment_seat', kind: 'constraint', consequence: 'an appointment could hold a seat number beyond its slot capacity' },
  { name: 'ck_appointment_cancelled_by', kind: 'constraint', consequence: 'a cancellation could be recorded without who cancelled it' },
  // Migration 007 adds this one only where the database allows it (it needs the btree_gist extension and no overlapping old data).
  { name: 'ex_appointments_no_overlap', kind: 'constraint', consequence: 'overlapping appointments for one seat are prevented by the booking code only, not by the database' },
];

/** The guards that are missing from this database (an empty list when all are present). */
export async function missingSchemaGuards(dataSource: Queryable): Promise<MissingGuard[]> {
  const constraints = new Set<string>(((await dataSource.query("SELECT conname FROM pg_constraint WHERE conrelid = 'appointments'::regclass")) as { conname: string }[]).map((row) => row.conname));
  const indexes = new Set<string>(((await dataSource.query("SELECT indexname FROM pg_indexes WHERE tablename = 'appointments'")) as { indexname: string }[]).map((row) => row.indexname));
  return GUARDS.filter((guard) => !(guard.kind === 'constraint' ? constraints : indexes).has(guard.name)).map(({ name, consequence }) => ({ name, consequence }));
}

/** Tables later migrations add, and what stops working without them, so a database that was not migrated is reported at start-up. */
const REQUIRED_TABLES = [
  {
    name: 'assistant_actions',
    migration: '012_assistant_actions.sql',
    consequence: 'the assistant cannot prepare bookings, moves or cancellations (they fail as "temporarily unavailable")',
  },
  {
    name: 'assistant_conversations',
    migration: '013_assistant_history.sql',
    consequence: 'the assistant still answers, but chat history is not saved and the history list is unavailable',
  },
];

export interface MissingTable {
  name: string;
  migration: string;
  consequence: string;
}

/** The required tables this database does not have (an empty list when migrations are up to date). */
export async function missingTables(dataSource: Queryable): Promise<MissingTable[]> {
  const missing: MissingTable[] = [];
  for (const table of REQUIRED_TABLES) {
    const rows = (await dataSource.query(`SELECT to_regclass('public.${table.name}') AS found`)) as { found: string | null }[];
    if (!rows[0]?.found) missing.push(table);
  }
  return missing;
}

/** Columns later migrations add to existing tables, and what stops working without them. */
const REQUIRED_COLUMNS = [
  {
    table: 'appointments',
    column: 'hidden_by_patient_at',
    migration: '014_hide_appointments_from_history.sql',
    consequence: 'patients cannot remove past bookings from their history (everything else keeps working)',
  },
];

export interface MissingColumn {
  table: string;
  column: string;
  migration: string;
  consequence: string;
}

/** The required columns this database does not have (an empty list when migrations are up to date). */
export async function missingColumns(dataSource: Queryable): Promise<MissingColumn[]> {
  const missing: MissingColumn[] = [];
  for (const entry of REQUIRED_COLUMNS) {
    const rows = (await dataSource.query(`SELECT 1 AS found FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${entry.table}' AND column_name = '${entry.column}'`)) as unknown[];
    if (rows.length === 0) missing.push(entry);
  }
  return missing;
}

// Load and invariant check for SHRINKING hours. It is a check of behaviour under concurrency, not a benchmark of a production
// deployment: one machine, one database, so it shows the invariants hold and where the time goes, not what 100k users cost.
//
//   1. start the backend against a THROWAWAY database with background jobs ON, e.g.
//        TEST_DATABASE_URL=postgresql://.../outpatient_test  (the database name must end in _test)
//        DATABASE_URL=$TEST_DATABASE_URL BACKGROUND_JOBS=true PORT=3199 RESEND_API_KEY= RAZORPAY_KEY_ID= RAZORPAY_KEY_SECRET= node dist/main
//   2. node scripts/load-elastic.mjs            (env: BASE_URL=http://localhost:3199/api, PATIENTS=400)
//
// It books many patients at once, shrinks the doctor's hours while more bookings arrive, shrinks it twice at once, waits for the
// background notifier, then has the affected patients pick new times at once. Then it EXPANDS the hours again, partly and then
// fully, while the notice queue is still being sent and bookings race the change (and the change is sent twice), and checks the
// invariants in the database: only covered appointments are released, rescheduled/cancelled ones are untouched, no withdrawn
// notice is ever sent, history is intact, and nothing is double-booked.

import pg from 'pg';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// The compiled backend (nest build) supplies the same password hashing the app verifies with. DIST_DIR points at another build output.
const { hashPassword } = await import(pathToFileURL(path.resolve(process.env.DIST_DIR ?? 'dist', 'auth/password.js')).href);

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3199/api';
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PATIENTS = Number(process.env.PATIENTS ?? 400);
const PER_SLOT = 60;
if (!DATABASE_URL) throw new Error('Set TEST_DATABASE_URL (a throwaway database).');
if (!/_test(\?|$)/.test(DATABASE_URL)) throw new Error('Refusing to run: the database name must end in _test, because this script deletes appointments.');

const PASSWORD = 'Load@1234';
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

const clinicDate = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const monday = (() => {
  for (let n = 1; n < 9; n++) if (new Date(`${clinicDate(n)}T00:00:00Z`).getUTCDay() === 1) return clinicDate(n);
})();

const timings = {};
const timed = async (name, fn) => {
  const started = performance.now();
  const result = await fn();
  (timings[name] ??= []).push(performance.now() - started);
  return result;
};
const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length * p) / 100))];
const pool = async (items, size, fn) => {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
};
const call = async (method, path, token, body) => {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
};

// ---- fixtures ----
await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments; DELETE FROM schedule_overrides; DELETE FROM availability;');
const hash = await hashPassword(PASSWORD);
const upsertUser = async (name, email, role) =>
  (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id', [name, email, hash, role])).rows[0].id;
const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('Load') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id")).rows[0].id;
const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Load clinic', '1 Load St') RETURNING id")).rows[0].id;
const doctorUser = await upsertUser('Dr. Load', 'load-doctor@test.local', 'DOCTOR');
const doctorId =
  (await db.query('SELECT id FROM doctors WHERE user_id = $1', [doctorUser])).rows[0]?.id ??
  (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id', [doctorUser, clinicId, specialtyId])).rows[0].id;
await db.query('UPDATE doctors SET clinic_id = $2 WHERE id = $1', [doctorId, clinicId]);
const patientEmails = [];
for (let n = 1; n <= PATIENTS; n++) {
  const email = `load-p${n}@test.local`;
  const userId = await upsertUser(`Load Patient ${n}`, email, 'PATIENT');
  await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, `+9190000${String(n).padStart(5, '0')}`]);
  patientEmails.push(email);
}
const rowId = (
  await db.query(
    `INSERT INTO availability (doctor_id, recurrence_type, day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
     VALUES ($1, 'WEEKLY', 1, '10:00', '14:00', 'WAVE', $2, 30) RETURNING id`,
    [doctorId, PER_SLOT],
  )
).rows[0].id;
console.log(`fixtures: ${PATIENTS} patients, 1 doctor, Monday ${monday} 10:00-14:00, ${PER_SLOT} places per slot (${8 * PER_SLOT} seats)`);

const login = async (email) => (await call('POST', '/auth/login', null, { email, password: PASSWORD })).body.accessToken;
const doctorToken = await login('load-doctor@test.local');
const tokens = await pool(patientEmails, 25, login);
check('every patient could log in', tokens.every(Boolean));

// ---- phase A: everyone books at once, spread over the 8 slots ----
const slotStarts = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30'];
const booked = await pool(tokens, 50, (token, index) => timed('book', () => call('POST', '/appointments', token, { doctorId, date: monday, startTime: slotStarts[index % 8] })));
const created = booked.filter((r) => r.status === 201);
check('all patients booked', created.length === PATIENTS, `${created.length}/${PATIENTS}, others: ${[...new Set(booked.filter((r) => r.status !== 201).map((r) => r.status))].join(',') || 'none'}`);

// ---- phase B: shrink 10:00-14:00 -> 10:00-12:00 while late bookings race it, and the same shrink is sent twice ----
const racers = tokens.slice(0, 40).map((token, index) => () => call('POST', '/appointments', token, { doctorId, date: monday, startTime: slotStarts[4 + (index % 4)] }));
const shrinkBody = { startTime: '10:00', endTime: '12:00', from: { startTime: '10:00', endTime: '14:00' }, acknowledge: true };
const [applyA, applyB, ...raced] = await Promise.all([
  timed('apply', () => call('POST', `/doctor-portal/availability/${rowId}/change`, doctorToken, shrinkBody)),
  timed('apply', () => call('POST', `/doctor-portal/availability/${rowId}/change`, doctorToken, shrinkBody)),
  ...racers.map((run) => run()),
]);
check('the shrink was applied exactly once when sent twice', [applyA.status, applyB.status].filter((s) => s === 200).length === 1, `statuses ${applyA.status}, ${applyB.status}`);
const affected = (await db.query("SELECT count(*)::int AS n FROM appointments WHERE status IN ('PENDING','CONFIRMED') AND start_time >= '12:00'")).rows[0].n;
const tracked = (await db.query('SELECT count(*)::int AS n FROM schedule_change_appointments')).rows[0].n;
check('every appointment left outside the hours is recorded', tracked === affected, `${tracked} recorded, ${affected} outside`);
check('nothing was cancelled by the change', (await db.query("SELECT count(*)::int AS n FROM appointments WHERE status = 'CANCELLED'")).rows[0].n === 0);
const lateAccepted = raced.filter((r) => r.status === 201).length;
console.log(`        ${lateAccepted} late bookings landed before the change (and were recorded), ${raced.length - lateAccepted} were refused after it`);

// ---- phase C: the background notifier ----
const waitStarted = performance.now();
let waiting = tracked;
while (waiting > 0 && performance.now() - waitStarted < 180_000) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  waiting = (await db.query('SELECT count(*)::int AS n FROM schedule_change_appointments WHERE notified_at IS NULL AND resolved_at IS NULL AND attempts < 5')).rows[0].n;
}
check('every affected patient was asked by the background job', waiting === 0, `${((performance.now() - waitStarted) / 1000).toFixed(1)}s for ${tracked}; ${waiting} still waiting (is BACKGROUND_JOBS on?)`);
const duplicates = (await db.query("SELECT appointment_id FROM notifications WHERE kind = 'needs-new-time' AND channel = 'email' GROUP BY appointment_id HAVING count(*) > 1")).rowCount;
check('no patient was asked twice', duplicates === 0);

// ---- phase D: the affected patients choose new times at once ----
const affectedPatients = (await db.query("SELECT a.id AS appointment_id, u.email FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id WHERE a.status IN ('PENDING','CONFIRMED') AND a.start_time >= '12:00'")).rows;
const byEmail = new Map(patientEmails.map((email, index) => [email, tokens[index]]));
const moves = await pool(affectedPatients, 50, async (row) => {
  const token = byEmail.get(row.email);
  const options = await timed('alternatives', () => call('GET', `/appointments/${row.appointment_id}/alternatives`, token));
  const choice = options.body?.alternatives?.[0];
  if (!choice) return { status: 'none' };
  return timed('reschedule', () => call('POST', `/appointments/${row.appointment_id}/reschedule`, token, { date: choice.date, startTime: choice.startTime }));
});
const moved = moves.filter((m) => m.status === 201).length;
const refused = moves.filter((m) => m.status === 409).length;
console.log(`        ${affectedPatients.length} affected: ${moved} moved, ${refused} refused (time taken, can choose again), ${moves.filter((m) => m.status === 'none').length} had nothing open`);

// ---- phase D2: the reduction's own invariant, checked before anything is widened ----
check('every unmoved affected appointment is still booked and recorded', ((await db.query("SELECT 1 FROM appointments a WHERE a.status IN ('PENDING','CONFIRMED') AND a.start_time >= '12:00' AND NOT EXISTS (SELECT 1 FROM schedule_change_appointments s WHERE s.appointment_id = a.id)")).rowCount) === 0);

// ---- phase E: EXPAND while the notice queue is still being sent and bookings race the change ----
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const currentRow = async () => (await q("SELECT id FROM availability WHERE recurrence_type = 'WEEKLY' AND effective_to IS NULL"))[0].id;
const snapshot = async () => ({
  byResolution: Object.fromEntries((await q('SELECT coalesce(resolution, $1) AS r, count(*)::int AS n FROM schedule_change_appointments GROUP BY 1', ['OPEN'])).map((r) => [r.r, r.n])),
  cancelled: (await q("SELECT count(*)::int AS n FROM appointments WHERE status = 'CANCELLED'"))[0].n,
  active: (await q("SELECT count(*)::int AS n FROM appointments WHERE status IN ('PENDING','CONFIRMED')"))[0].n,
  settled: await q("SELECT change_id, appointment_id, resolution, resolved_at FROM schedule_change_appointments WHERE resolution IN ('RESCHEDULED', 'CANCELLED', 'CLOSED') ORDER BY change_id, appointment_id"),
  shrinkRows: await q("SELECT id, kind, affected_count, old_end_time::text, new_end_time::text FROM schedule_changes WHERE kind = 'SHRINK' ORDER BY id"),
});
// Moved appointments are marked RESCHEDULED by the next background pass (every 30 s); wait for it so they count as settled.
for (let waited = 0; waited < 60_000; waited += 2000) {
  const stale = (await q("SELECT 1 FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id WHERE s.resolved_at IS NULL AND a.status NOT IN ('PENDING','CONFIRMED')")).length;
  if (stale === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
const before = await snapshot();
check('moved appointments are settled as RESCHEDULED before the expansion', before.settled.length === moved, `${before.settled.length} settled, ${moved} moved`);
const queuedBefore = (await q("SELECT count(*)::int AS n FROM notifications WHERE kind = 'needs-new-time' AND status = 'PENDING'"))[0].n;
console.log(`\nexpanding while ${queuedBefore} "choose a new time" notices are still queued; before: ${JSON.stringify(before.byResolution)}`);

// Partly: 10:00-12:00 -> 10:00-13:00 releases the 12:00 and 12:30 appointments, not the 13:00 and 13:30 ones. Sent twice at once,
// with bookings for the newly reopened slots racing it.
const expandBody = { startTime: '10:00', endTime: '13:00', from: { startTime: '10:00', endTime: '12:00' } };
const reopenedRacers = tokens.slice(100, 160).map((token, index) => () => timed('book during expansion', () => call('POST', '/appointments', token, { doctorId, date: monday, startTime: index % 2 ? '12:00' : '12:30' })));
const partRow = await currentRow();
const [expandA, expandB, ...expandRaced] = await Promise.all([
  timed('expand', () => call('POST', `/doctor-portal/availability/${partRow}/change`, doctorToken, expandBody)),
  timed('expand', () => call('POST', `/doctor-portal/availability/${partRow}/change`, doctorToken, expandBody)),
  ...reopenedRacers.map((run) => run()),
]);
check('the expansion was applied exactly once when sent twice', [expandA.status, expandB.status].filter((s) => s === 200).length === 1, `statuses ${expandA.status}, ${expandB.status}`);
const winner = expandA.status === 200 ? expandA.body : expandB.body;
console.log(`        released ${winner?.restoredAppointments} appointments, withdrew ${winner?.withdrawnNotices} queued notices; ${expandRaced.filter((r) => r.status === 201).length} bookings in the reopened time landed, ${expandRaced.filter((r) => r.status !== 201).length} refused`);

const afterPart = await snapshot();
check('partial expansion: the released appointments are exactly those the new hours cover', (await q("SELECT 1 FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id WHERE a.status IN ('PENDING','CONFIRMED') AND ((a.start_time < '13:00' AND s.resolution IS DISTINCT FROM 'COVERED') OR (a.start_time >= '13:00' AND s.resolution IS NOT NULL))")).length === 0);
check('partial expansion: appointments already moved or cancelled keep exactly their resolution and time', before.settled.every((row) => afterPart.settled.some((later) => later.change_id === row.change_id && later.appointment_id === row.appointment_id && later.resolution === row.resolution && String(later.resolved_at) === String(row.resolved_at))), `${before.settled.length} settled rows compared`);
check('partial expansion: nobody was cancelled by it', afterPart.cancelled === before.cancelled);
check('partial expansion: no queued notice is left for a released appointment', (await q("SELECT 1 FROM notifications n JOIN schedule_change_appointments s ON s.appointment_id = n.appointment_id WHERE n.kind = 'needs-new-time' AND n.status = 'PENDING' AND s.resolution = 'COVERED'")).length === 0);
check('partial expansion: the 13:00 and 13:30 patients are still waiting and still queued or asked', (await q("SELECT 1 FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id WHERE a.status IN ('PENDING','CONFIRMED') AND a.start_time >= '13:00' AND s.resolution IS NULL")).length > 0);

// Fully: back to 10:00-14:00 releases the rest.
const fullRow = await currentRow();
const full = await timed('expand', () => call('POST', `/doctor-portal/availability/${fullRow}/change`, doctorToken, { startTime: '10:00', endTime: '14:00', from: { startTime: '10:00', endTime: '13:00' } }));
check('the full expansion was applied', full.status === 200, `status ${full.status}, released ${full.body?.restoredAppointments}, withdrew ${full.body?.withdrawnNotices}`);
const afterFull = await snapshot();
check('full expansion: nobody who is still booked is left waiting', (await q("SELECT 1 FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id WHERE s.resolved_at IS NULL AND a.status IN ('PENDING','CONFIRMED')")).length === 0, JSON.stringify(afterFull.byResolution));
check('full expansion: nothing was cancelled and no active appointment was lost', afterFull.cancelled === before.cancelled && afterFull.active >= before.active, `active ${before.active} -> ${afterFull.active}`);
check('history is intact: every earlier reduction is unchanged and the expansions were added', JSON.stringify(afterFull.shrinkRows) === JSON.stringify(before.shrinkRows) && (await q("SELECT count(*)::int AS n FROM schedule_changes WHERE kind = 'EXPAND'"))[0].n === 2);
check('the tracking rows were all kept (none deleted)', (await q('SELECT count(*)::int AS n FROM schedule_change_appointments'))[0].n >= tracked);

// ---- phase E2: a backlog in the outbox. The sender is held (a trigger pushes the send time of new "choose a new time" notices
// half an hour out, as if the mail provider were slow), the hours are reduced again, then widened partly and fully. Every notice
// that was waiting for an appointment the new hours cover must be withdrawn, and none may go out. ----
await db.query("CREATE OR REPLACE FUNCTION hold_new_time() RETURNS trigger AS $$ BEGIN IF NEW.kind = 'needs-new-time' THEN NEW.send_at := now() + interval '30 minutes'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql");
await db.query('CREATE TRIGGER hold_new_time BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION hold_new_time()');
try {
  const againId = await currentRow();
  const shrinkAgain = await call('POST', `/doctor-portal/availability/${againId}/change`, doctorToken, { startTime: '10:00', endTime: '12:00', from: { startTime: '10:00', endTime: '14:00' }, acknowledge: true });
  check('the second reduction was applied', shrinkAgain.status === 200, `status ${shrinkAgain.status}, ${shrinkAgain.body?.affectedAppointments} affected`);
  const queueStarted = performance.now();
  let unqueued = 1;
  while (unqueued > 0 && performance.now() - queueStarted < 120_000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    unqueued = (await q('SELECT count(*)::int AS n FROM schedule_change_appointments WHERE notified_at IS NULL AND resolved_at IS NULL AND attempts < 5'))[0].n;
  }
  const held = (await q("SELECT count(*)::int AS n FROM notifications WHERE kind = 'needs-new-time' AND status = 'PENDING'"))[0].n;
  check('the notifier queued notices that are now held in the outbox', unqueued === 0 && held > 0, `${held} queued and waiting to be sent`);

  const partId = await currentRow();
  const part = await timed('expand', () => call('POST', `/doctor-portal/availability/${partId}/change`, doctorToken, { startTime: '10:00', endTime: '13:00', from: { startTime: '10:00', endTime: '12:00' } }));
  const heldAfterPart = (await q("SELECT count(*)::int AS n FROM notifications WHERE kind = 'needs-new-time' AND status = 'PENDING'"))[0].n;
  check('partial expansion withdrew exactly the queued notices of the appointments it released', part.status === 200 && part.body.withdrawnNotices === held - heldAfterPart, `withdrew ${part.body?.withdrawnNotices} of ${held}; ${heldAfterPart} still queued for the patients it did not reach`);
  check('the notices still queued belong only to patients who are still outside the hours', (await q("SELECT 1 FROM notifications n JOIN appointments a ON a.id = n.appointment_id WHERE n.kind = 'needs-new-time' AND n.status = 'PENDING' AND a.start_time < '13:00'")).length === 0);

  const restId = await currentRow();
  const rest = await timed('expand', () => call('POST', `/doctor-portal/availability/${restId}/change`, doctorToken, { startTime: '10:00', endTime: '14:00', from: { startTime: '10:00', endTime: '13:00' } }));
  const heldAfterAll = (await q("SELECT count(*)::int AS n FROM notifications WHERE kind = 'needs-new-time' AND status = 'PENDING'"))[0].n;
  check('full expansion withdrew the rest, leaving nothing queued', rest.status === 200 && heldAfterAll === 0, `withdrew ${rest.body?.withdrawnNotices}; ${heldAfterAll} left`);
  check('every withdrawn notice says why', (await q("SELECT 1 FROM notifications WHERE kind = 'needs-new-time' AND status = 'CANCELLED' AND (last_error IS NULL OR last_error NOT LIKE 'Not sent:%')")).length === 0);
} finally {
  await db.query('DROP TRIGGER IF EXISTS hold_new_time ON notifications; DROP FUNCTION IF EXISTS hold_new_time()');
}

// The dispatcher keeps running in the background: nothing released may be sent after its release.
await new Promise((resolve) => setTimeout(resolve, 35_000));
check('no "choose a new time" email was sent after its appointment was released', (await q("SELECT 1 FROM notifications n JOIN schedule_change_appointments s ON s.appointment_id = n.appointment_id WHERE n.kind = 'needs-new-time' AND n.status = 'SENT' AND s.resolution = 'COVERED' AND n.sent_at > s.resolved_at")).length === 0);
check('no queued notice remains for a released appointment', (await q("SELECT 1 FROM notifications n JOIN schedule_change_appointments s ON s.appointment_id = n.appointment_id WHERE n.kind = 'needs-new-time' AND n.status = 'PENDING' AND s.resolution = 'COVERED'")).length === 0);

// ---- invariants ----
check('no place is double-booked', (await q("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time, slot_number HAVING count(*) > 1")).length === 0);
check('no slot is over capacity', (await q("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time HAVING count(*) > max(slot_capacity)")).length === 0);
check('no appointment was lost or duplicated by a move', (await q("SELECT 1 FROM appointments c WHERE c.rescheduled_from_id IS NOT NULL AND c.status IN ('PENDING','CONFIRMED') GROUP BY c.rescheduled_from_id HAVING count(*) > 1")).length === 0);
check('every moved appointment kept exactly one active replacement', (await q("SELECT 1 FROM appointments o WHERE o.status = 'CANCELLED' AND o.cancel_reason = 'Rescheduled by patient' AND (SELECT count(*) FROM appointments n WHERE n.rescheduled_from_id = o.id AND n.status IN ('PENDING','CONFIRMED')) <> 1")).length === 0);

console.log('\nlatency (ms)            n      p50      p95      max');
for (const [name, values] of Object.entries(timings)) console.log(`${name.padEnd(20)} ${String(values.length).padStart(5)} ${pct(values, 50).toFixed(0).padStart(8)} ${pct(values, 95).toFixed(0).padStart(8)} ${Math.max(...values).toFixed(0).padStart(8)}`);
await db.end();

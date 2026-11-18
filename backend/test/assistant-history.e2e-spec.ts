// Chat history for the assistant: a doctor or patient can see earlier conversations, reopen one, and delete it.
//  - every query is filtered by the signed-in user: someone else's conversation is "not found" (404, never 403);
//  - only text and lookup names are stored, never a confirmation token, and a reply that had a card is kept as a plain marker;
//  - history is best effort: if it cannot be saved or read, the chat answer is still returned.
// The real app, database and services run; only the model is replaced.

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { MAX_CONVERSATIONS, MAX_STORED_CHARS } from '../src/assistant/history/assistant-history.service.js';
import { LLM_CLIENT, type LlmClient, type LlmRequest, type LlmResponse } from '../src/assistant/llm/llm-client.js';
import { RateLimiter } from '../src/assistant/rate-limit.js';
import { EMAIL_SENDER } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { addDays, clinicNow } from '../src/scheduling/calendar.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.RESEND_API_KEY = '';
process.env.BREVO_API_KEY = '';
process.env.BACKGROUND_JOBS = 'false';

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const day = (n: number) => addDays(today, n);

describe('AI assistant: chat history (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  let doctorUserId: string;
  let receptionToken: string;
  const patientTokens: string[] = [];
  const patientIds: string[] = [];

  let reply: (request: LlmRequest) => LlmResponse | Error = () => ({ text: 'Here you go.', toolCalls: [] });
  const fakeModel: LlmClient = {
    configured: true,
    generate: async (req) => {
      const answer = reply(req);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const chat = (token: string, content: string, conversationId?: string) =>
    http().post('/api/assistant/chat').set(as(token)).send({ messages: [{ role: 'user', content }], ...(conversationId ? { conversationId } : {}) });
  const conversations = (token: string, query = '') => http().get(`/api/assistant/conversations${query}`).set(as(token));
  const open = (token: string, id: string) => http().get(`/api/assistant/conversations/${id}`).set(as(token));
  const remove = (token: string, id: string) => http().delete(`/api/assistant/conversations/${id}`).set(as(token));
  const stored = () => rows<{ conversation_id: string; role: string; text: string; tool_names: string[]; had_card: boolean }>('SELECT conversation_id, role, text, tool_names, had_card FROM assistant_messages ORDER BY seq');

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);
    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic A', '1 A St') RETURNING id")).rows[0].id as string;
    doctorUserId = await user('Dr. Hist', 'hdoc@test.local', 'DOCTOR');
    doctorId = (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id', [doctorUserId, clinicId, specialtyId])).rows[0].id as string;
    for (let n = 1; n <= 2; n++) {
      const id = await user(`Patient ${n}`, `hp${n}@test.local`, 'PATIENT');
      patientIds.push(id);
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000900${n}`]);
    }
    await user('Rita Reception', 'hrec@test.local', 'RECEPTIONIST');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ send: async () => ({ reference: 'em_1' }) })
      .overrideProvider(LLM_CLIENT)
      .useValue(fakeModel)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('hdoc@test.local');
    receptionToken = await login('hrec@test.local');
    for (let n = 1; n <= 2; n++) patientTokens.push(await login(`hp${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM assistant_conversations; DELETE FROM schedule_overrides; DELETE FROM availability;');
    reply = () => ({ text: 'Here you go.', toolCalls: [] });
    (app.get(AssistantService) as unknown as { limiter: RateLimiter }).limiter = new RateLimiter(10_000, 60_000);
  });

  describe('saving', () => {
    it('starts a conversation on the first message, titled by it, and keeps the chat reply exactly as before plus the id', async () => {
      const res = await chat(patientTokens[0], 'What are my upcoming appointments?').expect(200);
      expect(res.body).toEqual({ reply: 'Here you go.', toolsUsed: [], conversationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      const [conversation] = await rows<{ id: string; user_id: string; role: string; title: string }>('SELECT id, user_id, role, title FROM assistant_conversations');
      expect(conversation).toEqual({ id: res.body.conversationId, user_id: patientIds[0], role: 'PATIENT', title: 'What are my upcoming appointments?' });
      expect(await stored()).toEqual([
        { conversation_id: conversation.id, role: 'user', text: 'What are my upcoming appointments?', tool_names: [], had_card: false },
        { conversation_id: conversation.id, role: 'assistant', text: 'Here you go.', tool_names: [], had_card: false },
      ]);
    });

    it('shortens a long first message to about 60 characters on one line, and caps what is stored', async () => {
      const long = `Please   tell me\nabout ${'everything '.repeat(30)}`;
      const res = await chat(patientTokens[0], long).expect(200);
      const [conversation] = await rows<{ title: string }>('SELECT title FROM assistant_conversations WHERE id = $1', [res.body.conversationId]);
      expect(conversation.title.length).toBeLessThanOrEqual(60);
      expect(conversation.title).toMatch(/^Please tell me about everything.*…$/);
      expect(conversation.title).not.toMatch(/\n/);

      reply = () => ({ text: 'x'.repeat(MAX_STORED_CHARS + 500), toolCalls: [] });
      await chat(patientTokens[0], 'long answer please', res.body.conversationId).expect(200);
      const lengths = (await stored()).map((row) => row.text.length);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(MAX_STORED_CHARS);
    });

    it('adds to the same conversation when the id is sent, in order, and records which lookups were used', async () => {
      const first = await chat(patientTokens[0], 'first question').expect(200);
      reply = (req) =>
        req.messages.some((message) => message.role === 'tool')
          ? { text: 'You have none.', toolCalls: [] }
          : { text: '', toolCalls: [{ id: 'c1', name: 'get_my_appointments', args: {} }] };
      const second = await chat(patientTokens[0], 'second question', first.body.conversationId).expect(200);
      expect(second.body.conversationId).toBe(first.body.conversationId);
      expect(await rows('SELECT 1 FROM assistant_conversations')).toHaveLength(1);
      const messages = await stored();
      expect(messages.map((row) => `${row.role}:${row.text}`)).toEqual(['user:first question', 'assistant:Here you go.', 'user:second question', 'assistant:You have none.']);
      expect(messages[3].tool_names).toEqual(['get_my_appointments']);
    });

    it('stores only a marker for a reply that came with a card, and never the confirmation token or its details', async () => {
      await db.query(`INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes) VALUES ($1, 'ONE_TIME', $2, '09:00', '11:00', 'WAVE', 2, 30)`, [doctorId, day(6)]);
      reply = (req) =>
        req.messages.some((message) => message.role === 'tool')
          ? { text: 'A card is waiting for you.', toolCalls: [] }
          : { text: '', toolCalls: [{ id: 'c1', name: 'prepare_block_day', args: { date: day(6) } }] };
      const res = await chat(doctorToken, 'block next saturday').expect(200);
      expect(res.body.actions[0].ref).toMatch(/\./); // the live card still goes to the screen
      const everything = JSON.stringify(await rows('SELECT * FROM assistant_messages'));
      expect(everything).not.toContain(res.body.actions[0].ref);
      expect(everything).not.toMatch(/expiresAt|confirmLabel|"lines"/);
      expect((await stored()).map((row) => row.had_card)).toEqual([false, true]);
      const loaded = (await open(doctorToken, res.body.conversationId).expect(200)).body;
      expect(loaded.messages[1]).toMatchObject({ text: 'A card is waiting for you.', hadCard: true, toolNames: ['prepare_block_day'] });
      expect(JSON.stringify(loaded)).not.toContain(res.body.actions[0].ref);
    });

    it('works for doctors as well, and records their role', async () => {
      const res = await chat(doctorToken, "What's on my schedule today?").expect(200);
      expect(await rows('SELECT role, user_id FROM assistant_conversations WHERE id = $1', [res.body.conversationId])).toEqual([{ role: 'DOCTOR', user_id: doctorUserId }]);
    });

    it('keeps at most 200 conversations per person, deleting the oldest, and leaves other people alone', async () => {
      await db.query(
        `INSERT INTO assistant_conversations (user_id, role, title, created_at, updated_at)
         SELECT $1, 'PATIENT', 'old ' || n, now() - make_interval(hours => n), now() - make_interval(hours => n) FROM generate_series(1, $2) AS n`,
        [patientIds[0], MAX_CONVERSATIONS],
      );
      await db.query(`INSERT INTO assistant_conversations (user_id, role, title) VALUES ($1, 'PATIENT', 'someone else')`, [patientIds[1]]);
      await chat(patientTokens[0], 'a brand new one').expect(200);
      const mine = await rows<{ title: string }>('SELECT title FROM assistant_conversations WHERE user_id = $1 ORDER BY updated_at DESC', [patientIds[0]]);
      expect(mine).toHaveLength(MAX_CONVERSATIONS);
      expect(mine[0].title).toBe('a brand new one');
      expect(mine.map((row) => row.title)).not.toContain(`old ${MAX_CONVERSATIONS}`); // the oldest went
      expect(await rows('SELECT 1 FROM assistant_conversations WHERE user_id = $1', [patientIds[1]])).toHaveLength(1);
    });
  });

  describe('history is best effort: the chat always answers', () => {
    it('returns the reply, without an id, when messages cannot be saved', async () => {
      await db.query('ALTER TABLE assistant_messages RENAME TO assistant_messages_off');
      try {
        const res = await chat(patientTokens[0], 'will this still work?').expect(200);
        expect(res.body).toEqual({ reply: 'Here you go.', toolsUsed: [] });
        expect(await rows('SELECT 1 FROM assistant_conversations')).toEqual([]); // the half-saved conversation was rolled back
      } finally {
        await db.query('ALTER TABLE assistant_messages_off RENAME TO assistant_messages');
      }
    });

    it('returns the reply when the history tables are missing altogether (migration 013 not applied), even with a conversation id', async () => {
      const first = await chat(patientTokens[0], 'before').expect(200);
      await db.query('ALTER TABLE assistant_conversations RENAME TO assistant_conversations_off');
      try {
        const res = await chat(patientTokens[0], 'after', first.body.conversationId).expect(200);
        expect(res.body).toEqual({ reply: 'Here you go.', toolsUsed: [] });
        const fresh = await chat(patientTokens[0], 'and without an id').expect(200);
        expect(fresh.body.reply).toBe('Here you go.');
        expect(fresh.body.conversationId).toBeUndefined();
      } finally {
        await db.query('ALTER TABLE assistant_conversations_off RENAME TO assistant_conversations');
      }
    });

    it('a deleted conversation id is "not found", and the next message without it starts a new conversation', async () => {
      const first = await chat(patientTokens[0], 'to be deleted').expect(200);
      await remove(patientTokens[0], first.body.conversationId).expect(200);
      await chat(patientTokens[0], 'still here?', first.body.conversationId).expect(404);
      const again = await chat(patientTokens[0], 'still here?').expect(200);
      expect(again.body.conversationId).not.toBe(first.body.conversationId);
    });

    it('does not save anything when the assistant itself fails', async () => {
      reply = () => new Error('model down');
      await chat(patientTokens[0], 'hello').expect((res) => expect(res.status).toBeGreaterThanOrEqual(500));
      expect(await rows('SELECT 1 FROM assistant_conversations')).toEqual([]);
    });
  });

  describe('listing, opening and deleting', () => {
    it('lists the newest first and pages without repeating or skipping', async () => {
      const ids: string[] = [];
      for (let n = 1; n <= 5; n++) ids.push((await chat(patientTokens[0], `question ${n}`).expect(200)).body.conversationId);
      await chat(patientTokens[0], 'a follow-up to the first', ids[0]).expect(200); // the first becomes the newest
      const page1 = (await conversations(patientTokens[0], '?limit=2').expect(200)).body;
      expect(page1.conversations.map((entry: { title: string }) => entry.title)).toEqual(['question 1', 'question 5']);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = (await conversations(patientTokens[0], `?limit=2&cursor=${page1.nextCursor}`).expect(200)).body;
      const page3 = (await conversations(patientTokens[0], `?limit=2&cursor=${page2.nextCursor}`).expect(200)).body;
      expect([...page2.conversations, ...page3.conversations].map((entry: { title: string }) => entry.title)).toEqual(['question 4', 'question 3', 'question 2']);
      expect(page3.nextCursor).toBeNull();
      expect(page1.conversations[0]).toEqual({ id: ids[0], title: 'question 1', createdAt: expect.any(String), updatedAt: expect.any(String) });
    });

    it('opens one with its messages in order', async () => {
      const first = await chat(patientTokens[0], 'one').expect(200);
      await chat(patientTokens[0], 'two', first.body.conversationId).expect(200);
      const loaded = (await open(patientTokens[0], first.body.conversationId).expect(200)).body;
      expect(loaded).toMatchObject({ id: first.body.conversationId, title: 'one' });
      expect(loaded.messages.map((message: { role: string; text: string }) => `${message.role}:${message.text}`)).toEqual(['user:one', 'assistant:Here you go.', 'user:two', 'assistant:Here you go.']);
    });

    it('deletes one conversation for good, with its messages, and only that one', async () => {
      const keep = await chat(patientTokens[0], 'keep me').expect(200);
      const drop = await chat(patientTokens[0], 'delete me').expect(200);
      expect((await remove(patientTokens[0], drop.body.conversationId).expect(200)).body).toEqual({ deleted: true });
      expect(await rows('SELECT 1 FROM assistant_messages WHERE conversation_id = $1', [drop.body.conversationId])).toEqual([]);
      expect(await rows('SELECT 1 FROM assistant_messages WHERE conversation_id = $1', [keep.body.conversationId])).toHaveLength(2);
      await open(patientTokens[0], drop.body.conversationId).expect(404);
      await remove(patientTokens[0], drop.body.conversationId).expect(404);
      expect((await conversations(patientTokens[0]).expect(200)).body.conversations).toHaveLength(1);
    });

    it('rejects a bad id or cursor, and extra query fields', async () => {
      await open(patientTokens[0], 'not-a-uuid').expect(400);
      await remove(patientTokens[0], 'not-a-uuid').expect(400);
      await conversations(patientTokens[0], '?cursor=garbage').expect(400);
      await conversations(patientTokens[0], '?limit=0').expect(400);
      await conversations(patientTokens[0], '?userId=abc').expect(400);
      await http().post('/api/assistant/chat').set(as(patientTokens[0])).send({ messages: [{ role: 'user', content: 'hi' }], conversationId: 'nope' }).expect(400);
    });
  });

  describe('everyone sees only their own', () => {
    it('another person\'s conversation is "not found" to read, delete or add to, and their list never shows it', async () => {
      const theirs = await chat(patientTokens[1], 'my private question').expect(200);
      const mine = await chat(patientTokens[0], 'my own question').expect(200);
      for (const response of [await open(patientTokens[0], theirs.body.conversationId), await remove(patientTokens[0], theirs.body.conversationId), await chat(patientTokens[0], 'sneaky', theirs.body.conversationId)]) {
        expect(response.status).toBe(404); // never 403: it does not say the conversation exists
        expect(JSON.stringify(response.body)).not.toContain('private');
      }
      await open(doctorToken, theirs.body.conversationId).expect(404); // not even another role
      expect((await conversations(patientTokens[0]).expect(200)).body.conversations.map((entry: { id: string }) => entry.id)).toEqual([mine.body.conversationId]);
      // Nothing was changed by the attempts.
      expect(await rows('SELECT 1 FROM assistant_messages WHERE conversation_id = $1', [theirs.body.conversationId])).toHaveLength(2);
      expect((await open(patientTokens[1], theirs.body.conversationId).expect(200)).body.messages).toHaveLength(2);
    });

    it('needs a signed-in doctor or patient: nobody, and a receptionist, are turned away', async () => {
      const mine = await chat(patientTokens[0], 'hello').expect(200);
      await http().get('/api/assistant/conversations').expect(401);
      await http().get(`/api/assistant/conversations/${mine.body.conversationId}`).expect(401);
      await http().delete(`/api/assistant/conversations/${mine.body.conversationId}`).expect(401);
      await conversations(receptionToken).expect(403);
      await open(receptionToken, mine.body.conversationId).expect(403);
      await remove(receptionToken, mine.body.conversationId).expect(403);
      expect(await rows('SELECT 1 FROM assistant_conversations')).toHaveLength(1);
    });
  });
});

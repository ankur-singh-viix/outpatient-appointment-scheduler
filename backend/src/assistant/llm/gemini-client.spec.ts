import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { GeminiClient } from './gemini-client.js';
import { LlmError, type LlmRequest } from './llm-client.js';

// A stand-in for Google's server on localhost: it records what the client sends and replies as scripted. No network, no real key.
let server: Server;
let baseUrl: string;
const seen: { url: string; headers: IncomingMessage['headers']; body: any }[] = [];
let replies: { status: number; body: unknown }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const next = replies.shift() ?? { status: 500, body: {} };
      if (next.status === 0) return; // a model that never answers
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections(); // drop the connections the "never answers" tests left open
      server.close(() => resolve());
    }),
);

const keep: Record<string, string | undefined> = {};
const setEnv = (values: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in keep)) keep[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};
beforeEach(() => {
  seen.length = 0;
  replies = [];
  setEnv({ GEMINI_API_KEY: 'test-key-123', GEMINI_MODEL: 'gemini-test-flash', GEMINI_BASE_URL: baseUrl, ASSISTANT_TIMEOUT_SECONDS: '5' });
});
afterAll(() => {
  for (const [name, value] of Object.entries(keep)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  system: 'Be brief.',
  messages: [{ role: 'user', text: 'Who is next?' }],
  tools: [{ name: 'get_working_hours', description: 'Hours.', parameters: { type: 'object', properties: {} } }],
  maxOutputTokens: 300,
  ...overrides,
});
const textReply = (text: string) => ({ status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] } });

describe('GeminiClient', () => {
  it('sends the key in a header (never the URL), the system prompt, the conversation, the tools and the limits', async () => {
    replies = [textReply('Dr. Rao.')];
    const answer = await new GeminiClient().generate(request());
    expect(answer).toMatchObject({ text: 'Dr. Rao.', toolCalls: [] });
    const [call] = seen;
    expect(call.url).toBe('/v1beta/models/gemini-test-flash:generateContent');
    expect(call.url).not.toContain('test-key-123');
    expect(call.headers['x-goog-api-key']).toBe('test-key-123');
    expect(call.body).toEqual({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Who is next?' }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.2 },
      tools: [{ functionDeclarations: [{ name: 'get_working_hours', description: 'Hours.', parameters: { type: 'object', properties: {} } }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
  });

  it('sends no tool settings when there are no tools (the final answer after the last round)', async () => {
    replies = [textReply('Done.')];
    await new GeminiClient().generate(request({ tools: [] }));
    expect(seen[0].body).not.toHaveProperty('tools');
    expect(seen[0].body).not.toHaveProperty('toolConfig');
  });

  it("reads function calls, ignores the model's private thoughts, and replays its turn exactly as sent (signatures included)", async () => {
    const modelTurn = {
      role: 'model',
      parts: [
        { text: 'thinking about it', thought: true },
        { text: 'Let me look.' },
        { functionCall: { id: 'fc-1', name: 'get_working_hours', args: { days: 3 } }, thoughtSignature: 'sig-abc' },
      ],
    };
    replies = [{ status: 200, body: { candidates: [{ content: modelTurn, finishReason: 'STOP' }] } }, textReply('Mon to Fri.')];
    const client = new GeminiClient();
    const first = await client.generate(request());
    expect(first.text).toBe('Let me look.');
    expect(first.toolCalls).toEqual([{ id: 'call-1', name: 'get_working_hours', args: { days: 3 }, providerId: 'fc-1' }]);

    await client.generate(
      request({
        messages: [
          { role: 'user', text: 'Who is next?' },
          { role: 'assistant', text: first.text, toolCalls: first.toolCalls, provider: first.provider },
          { role: 'tool', results: [{ callId: 'call-1', name: 'get_working_hours', providerId: 'fc-1', output: { weekly: [] } }] },
        ],
      }),
    );
    expect(seen[1].body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Who is next?' }] },
      modelTurn, // untouched, signature and all
      { role: 'user', parts: [{ functionResponse: { id: 'fc-1', name: 'get_working_hours', response: { result: { weekly: [] } } } }] },
    ]);
  });

  it('rebuilds a model turn from text and calls when there is no provider copy (a turn the browser sent back)', async () => {
    replies = [textReply('ok')];
    await new GeminiClient().generate(request({ messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello!', toolCalls: [] }, { role: 'user', text: 'again' }] }));
    expect(seen[0].body.contents[1]).toEqual({ role: 'model', parts: [{ text: 'Hello!' }] });
  });

  it('turns provider failures into calm error kinds, retrying a server error once', async () => {
    const kind = async () => (await new GeminiClient().generate(request()).catch((error: LlmError) => error)) as LlmError;
    replies = [{ status: 429, body: { error: { message: 'quota for key test-key-123' } } }];
    const busy = await kind();
    expect(busy).toBeInstanceOf(LlmError);
    expect(busy.kind).toBe('rate_limited');
    expect(busy.message).not.toContain('test-key-123');
    expect(seen).toHaveLength(1); // no retry for a quota error

    seen.length = 0;
    replies = [{ status: 503, body: {} }, textReply('Recovered.')];
    expect((await new GeminiClient().generate(request())).text).toBe('Recovered.');
    expect(seen).toHaveLength(2);

    replies = [{ status: 500, body: {} }, { status: 502, body: {} }];
    expect((await kind()).kind).toBe('unavailable');
    replies = [{ status: 401, body: {} }];
    expect((await kind()).kind).toBe('not_configured');
    replies = [{ status: 403, body: {} }];
    expect((await kind()).kind).toBe('not_configured');
    replies = [{ status: 400, body: {} }];
    expect((await kind()).kind).toBe('bad_response');
    replies = [{ status: 200, body: 'this is not json' }];
    expect((await kind()).kind).toBe('bad_response');
  });

  it('gives up on a model that never answers after ONE timeout, without asking again', async () => {
    setEnv({ ASSISTANT_TIMEOUT_SECONDS: '1' });
    replies = [{ status: 0, body: null }, { status: 0, body: null }];
    const started = Date.now();
    await expect(new GeminiClient().generate(request())).rejects.toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(1900); // not twice the allowance
    expect(seen).toHaveLength(1);
  });

  it('lets a caller give one call less time than the default (a shrinking overall budget), never more', async () => {
    setEnv({ ASSISTANT_TIMEOUT_SECONDS: '5' });
    replies = [{ status: 0, body: null }];
    const started = Date.now();
    await expect(new GeminiClient().generate(request({ timeoutMs: 300 }))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(1500);
    // asking for more than the configured allowance is capped to it
    setEnv({ ASSISTANT_TIMEOUT_SECONDS: '1' });
    replies = [{ status: 0, body: null }];
    const capped = Date.now();
    await expect(new GeminiClient().generate(request({ timeoutMs: 60_000 }))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - capped).toBeLessThan(1900);
  });

  it('recognises a blocked or empty reply', async () => {
    const kind = async () => ((await new GeminiClient().generate(request()).catch((error: LlmError) => error)) as LlmError).kind;
    replies = [{ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }];
    expect(await kind()).toBe('blocked');
    replies = [{ status: 200, body: { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] } }];
    expect(await kind()).toBe('blocked');
    replies = [{ status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] } }];
    expect(await kind()).toBe('bad_response');
  });

  it('reports "not configured" without making any request when there is no key, and survives an unreachable server', async () => {
    setEnv({ GEMINI_API_KEY: '' });
    const client = new GeminiClient();
    expect(client.configured).toBe(false);
    await expect(client.generate(request())).rejects.toMatchObject({ kind: 'not_configured' });
    expect(seen).toHaveLength(0);

    setEnv({ GEMINI_API_KEY: 'k', GEMINI_BASE_URL: 'http://127.0.0.1:1' });
    await expect(new GeminiClient().generate(request())).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('assistant settings', () => {
  it('has safe defaults and clamps what it is given', () => {
    setEnv({ GEMINI_API_KEY: undefined, GEMINI_MODEL: undefined, GEMINI_BASE_URL: undefined, ASSISTANT_MAX_OUTPUT_TOKENS: undefined, ASSISTANT_TIMEOUT_SECONDS: undefined, ASSISTANT_RATE_LIMIT: undefined, ASSISTANT_RATE_WINDOW_MINUTES: undefined, ASSISTANT_CONFIRMATION_MINUTES: undefined });
    expect(loadConfig().assistant).toEqual({
      geminiApiKey: '',
      geminiModel: 'gemini-3.5-flash-lite',
      geminiBaseUrl: 'https://generativelanguage.googleapis.com',
      maxOutputTokens: 800,
      timeoutMs: 30_000,
      rateLimit: 20,
      rateWindowMinutes: 10,
      confirmationMinutes: 5,
    });
    setEnv({ GEMINI_API_KEY: '  abc  ', GEMINI_MODEL: 'gemini-x', GEMINI_BASE_URL: 'http://example.test///', ASSISTANT_MAX_OUTPUT_TOKENS: '999999', ASSISTANT_TIMEOUT_SECONDS: '9999', ASSISTANT_RATE_LIMIT: '0', ASSISTANT_RATE_WINDOW_MINUTES: '5', ASSISTANT_CONFIRMATION_MINUTES: '999' });
    expect(loadConfig().assistant).toMatchObject({ geminiApiKey: 'abc', geminiModel: 'gemini-x', geminiBaseUrl: 'http://example.test', maxOutputTokens: 4096, timeoutMs: 120_000, rateLimit: 1, rateWindowMinutes: 5, confirmationMinutes: 60 });
  });
});

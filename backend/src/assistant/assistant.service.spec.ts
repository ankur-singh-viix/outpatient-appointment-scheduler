import { BadGatewayException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/auth.types.js';
import { AssistantService, MAX_HISTORY } from './assistant.service.js';
import type { LlmClient, LlmRequest, LlmResponse, ToolResult } from './llm/llm-client.js';

// The orchestration on its own: a scripted model and stand-in services, so each rule can be checked without a database.
const doctor: AuthUser = { id: 'user-1', name: 'Dr. Rao', role: 'DOCTOR' };

function build(portal: Record<string, unknown>, script: (request: LlmRequest, round: number) => LlmResponse) {
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    configured: true,
    generate: async (request) => {
      requests.push(structuredClone(request));
      return script(request, requests.length - 1);
    },
  };
  const service = new AssistantService(llm, portal as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { service, requests };
}

const callOnce = (calls: { name: string; args?: Record<string, unknown> }[]) => (request: LlmRequest): LlmResponse =>
  request.messages.some((message) => message.role === 'tool') ? { text: 'Done.', toolCalls: [] } : { text: '', toolCalls: calls.map((call, index) => ({ id: `c${index}`, name: call.name, args: call.args ?? {} })) };

const toolResults = (requests: LlmRequest[]): ToolResult[] => {
  const message = requests.at(-1)?.messages.find((candidate) => candidate.role === 'tool');
  return message && message.role === 'tool' ? message.results : [];
};

describe('AssistantService', () => {
  it('refuses roles that have no assistant', async () => {
    const { service } = build({}, () => ({ text: 'x', toolCalls: [] }));
    await expect(service.chat({ id: 'u', name: 'Desk', role: 'RECEPTIONIST' }, [{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps only the most recent turns and never starts with a model turn', async () => {
    const { service, requests } = build({}, () => ({ text: 'ok', toolCalls: [] }));
    const turns = Array.from({ length: 25 }, (_, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: `t${i}` }));
    await service.chat(doctor, [...turns, { role: 'user', content: 'now' }]);
    const sent = requests[0].messages;
    expect(sent.length).toBeLessThanOrEqual(MAX_HISTORY);
    expect(sent[0].role).toBe('user');
    expect(sent.at(-1)).toEqual({ role: 'user', text: 'now' });
    await service.chat(doctor, [{ role: 'assistant', content: 'stale' }, { role: 'user', content: 'q' }]);
    expect(requests[1].messages).toEqual([{ role: 'user', text: 'q' }]);
  });

  it('answers an unknown tool, a flood of calls and bad arguments with short errors the model can read', async () => {
    const { service, requests } = build({}, callOnce([{ name: 'delete_everything' }, { name: 'get_appointments_on_date', args: { date: 'soon' } }, { name: 'get_working_hours' }, { name: 'get_working_hours' }, { name: 'get_working_hours' }]));
    await service.chat(doctor, [{ role: 'user', content: 'hi' }]);
    const [unknown, invalid, , , flooded] = toolResults(requests).map((result) => result.output as { error: string });
    expect(unknown.error).toBe('That tool does not exist.');
    expect(invalid.error).toMatch(/Invalid input: date/);
    expect(flooded.error).toMatch(/Too many lookups/);
  });

  it('never passes internal failures through, but does explain ordinary refusals from the real services', async () => {
    const { service, requests } = build(
      {
        availability: async () => {
          throw new Error('connection to db-prod-7 refused, password=hunter2');
        },
        appointments: async () => {
          throw new NotFoundException('Appointment not found.');
        },
        appointmentStatistics: async () => {
          throw new ForbiddenException('No doctor profile is linked to this account.');
        },
      },
      callOnce([{ name: 'get_working_hours' }, { name: 'get_appointments_on_date' }, { name: 'get_appointment_statistics' }]),
    );
    await service.chat(doctor, [{ role: 'user', content: 'hi' }]);
    const outputs = toolResults(requests).map((result) => result.output as { error: string });
    expect(outputs[0]).toEqual({ error: 'That information is temporarily unavailable.' });
    expect(JSON.stringify(outputs[0])).not.toMatch(/hunter2|db-prod/);
    expect(outputs[1]).toEqual({ error: 'Appointment not found.' });
    expect(outputs[2]).toEqual({ error: 'That information is temporarily unavailable.' }); // access errors are not explained
  });

  it('does not send the model a result too large to be useful (it would only cost money)', async () => {
    const weekly = Array.from({ length: 400 }, (_, i) => ({ dayOfWeek: i % 7, startTime: '09:00', endTime: '17:00', schedulingMode: 'STREAM', slotDurationMinutes: 30, capacityPerSlot: 1, capacity: null, effectiveFrom: null, effectiveTo: null }));
    const { service, requests } = build({ availability: async () => ({ consultationMinutes: 30, slotIntervalMinutes: 30, weekly, oneTime: [], overrides: [] }) }, callOnce([{ name: 'get_working_hours' }]));
    await service.chat(doctor, [{ role: 'user', content: 'hi' }]);
    expect((toolResults(requests)[0].output as { error: string }).error).toMatch(/too large/);
  });

  it('stops asking the model once the chat has used its total time, and gives each call only the time that is left', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      const timeouts: (number | undefined)[] = [];
      const llm: LlmClient = {
        configured: true,
        generate: async (request) => {
          timeouts.push(request.timeoutMs);
          vi.setSystemTime(Date.now() + 40_000); // every model call is slow
          return { text: '', toolCalls: [{ id: 'c', name: 'get_working_hours', args: {} }] };
        },
      };
      const portal = { availability: async () => ({ consultationMinutes: 30, slotIntervalMinutes: 30, weekly: [], oneTime: [], overrides: [] }) };
      const service = new AssistantService(llm, portal as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
      await expect(service.chat(doctor, [{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(BadGatewayException);
      expect(timeouts).toEqual([60_000, 20_000]); // twice the per-call allowance in all; the third round was never started
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a failed lookup with its class and the database error code, never its message or data', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('relation "assistant_actions" does not exist: patient Ankur Kumar'), { name: 'QueryFailedError', code: '42P01' });
    const { service } = build({ availability: async () => { throw failure; } }, callOnce([{ name: 'get_working_hours' }]));
    await service.chat(doctor, [{ role: 'user', content: 'hi' }]);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('QueryFailedError, code 42P01'))).toBe(true);
    expect(lines.join(' ')).not.toMatch(/Ankur|assistant_actions|does not exist/);
    warn.mockRestore();
  });
});

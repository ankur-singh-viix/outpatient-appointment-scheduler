import { Logger } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';
import type { User } from '../database/entities/index.js';
import { DeliveryError } from '../notifications/delivery-error.js';
import type { EmailMessage, EmailSender } from './email-sender.js';
import { InvitationService } from './invitation.service.js';

const SECRET_TOKEN = 'header.payload.SECRET-SIGNATURE-VALUE';
const jwt = { signAsync: async () => SECRET_TOKEN } as unknown as JwtService;
const user = { id: 'user-1', name: 'Reena Reception', email: 'reena@clinic.example' };

function service(email: EmailSender) {
  return new InvitationService(jwt, {} as Repository<User>, email);
}

/** Every line the service (and the loggers it uses) wrote, so a test can prove what never appears in them. */
function captureLogs() {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const) vi.spyOn(Logger.prototype, method).mockImplementation(keep);
  return lines;
}

describe('InvitationService.send', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.clinic.example/';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('reports "sent" only when a real provider accepted the email, and the email carries the right link', async () => {
    const sent: EmailMessage[] = [];
    const result = await service({
      send: async (message) => {
        sent.push(message);
        return { reference: 'em_123' };
      },
    }).send(user, 'Clinic A');

    expect(result).toEqual({ status: 'sent' });
    expect(sent[0].to).toBe('reena@clinic.example');
    expect(sent[0].text).toContain(`https://app.clinic.example/invite?token=${SECRET_TOKEN}`); // FRONTEND_URL, no doubled slash
    expect(sent[0].text).toMatch(/72 hours/);
  });

  it('reports "logged" when the development stand-in only printed it, never "sent"', async () => {
    expect(await service({ send: async () => ({ mode: 'dev-log' as const }) }).send(user, 'Clinic A')).toEqual({ status: 'logged' });
  });

  it("reports \"failed\" with the provider's own reason when it refuses", async () => {
    const refusal = new DeliveryError('Resend responded with HTTP 403 (validation_error: You can only send testing emails to your own email address)', false, 'validation_error');
    const result = await service({ send: async () => Promise.reject(refusal) }).send(user, 'Clinic A');
    expect(result).toEqual({ status: 'failed', reason: refusal.message });
  });

  it('reports "failed" for any other error with a generic reason, without repeating its text', async () => {
    const result = await service({ send: async () => Promise.reject(new Error(`connect failed for ${SECRET_TOKEN}`)) }).send(user, 'Clinic A');
    expect(result).toEqual({ status: 'failed', reason: 'The email could not be sent.' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('never returns the link or the token, in any outcome', async () => {
    const senders: EmailSender[] = [
      { send: async () => ({ reference: 'em_1' }) },
      { send: async () => ({ mode: 'dev-log' as const }) },
      { send: async () => Promise.reject(new DeliveryError('Resend responded with HTTP 500', true)) },
    ];
    for (const sender of senders) {
      const result = JSON.stringify(await service(sender).send(user, 'Clinic A'));
      expect(result).not.toMatch(/token|invite\?|SECRET/i);
    }
  });

  it('writes the token and link to no log of its own, whatever the outcome (production sends through Resend, so nothing prints it)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://x:y@host/db';
    process.env.JWT_SECRET = 'a-real-secret';
    const lines = captureLogs();
    await service({ send: async () => ({ reference: 'em_1' }) }).send(user, 'Clinic A');
    await service({ send: async () => Promise.reject(new DeliveryError('Resend responded with HTTP 403 (validation_error: nope)', false)) }).send(user, 'Clinic A');
    await service({ send: async () => Promise.reject(new Error(`boom ${SECRET_TOKEN} https://app.clinic.example/invite?token=${SECRET_TOKEN}`)) }).send(user, 'Clinic A');
    const everything = lines.join('\n');
    expect(everything).not.toContain('SECRET');
    expect(everything).not.toMatch(/invite\?token/);
    expect(everything).not.toContain('reena@clinic.example'); // nor the recipient: the account id identifies it
    expect(lines.some((line) => line.includes('account user-1'))).toBe(true);
  });
});

import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';
import { parseReminderKey, reminderSlot } from './reminder-keys.js';

export interface NotificationItem {
  id: string;
  kind: string;
  subject: string;
  body: string;
  /** SENT: delivered. SCHEDULED: a reminder waiting for its time. QUEUED: due and about to go out (or being retried). */
  status: 'SENT' | 'SCHEDULED' | 'QUEUED';
  /** When it was sent, or when it is due. */
  at: Date;
  /** For a reminder: when it is (or was) due to go out. */
  sendAt: Date;
  /** For a reminder: how many hours before the appointment it goes out (24, 1, ...). */
  intervalHours: number | null;
  /** How it is delivered: 'email', or 'sms' for a text reminder. */
  channel: 'email' | 'sms';
  appointmentId: string;
  /** Which appointment the message is about, so the page can group and describe it. */
  appointment: { doctorName: string; date: string; startTime: string; endTime: string } | null;
}

const preferencesSchema = z
  .strictObject({
    smsEnabled: z.boolean().optional(),
    emailReminders: z.boolean().optional(),
    smsReminders: z.boolean().optional(),
    promotionalEmail: z.boolean().optional(),
    promotionalSms: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one preference to change.' });

@Controller('notifications')
@UseGuards(AuthGuard)
@Roles('PATIENT')
export class NotificationsController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /** How this patient is contacted: texts for essential updates, reminders per channel, and promotional opt-ins (off unless ticked). */
  @Get('preferences')
  preferences(@CurrentUser() user: AuthUser) {
    return this.notifications.getPreferences(user.id);
  }

  /** Change any of the choices. Essential appointment emails are not among them: they are always sent. */
  @Put('preferences')
  updatePreferences(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(preferencesSchema)) body: z.infer<typeof preferencesSchema>) {
    return this.notifications.updatePreferences(user.id, body);
  }

  /**
   * The messages CareSlot has sent the signed-in patient about their appointments, and the reminders still to come. Newest first.
   * Only messages addressed to this patient (never the doctor's copies), and each message once: the email is the in-app record, so
   * the text copy of an ordinary event is not listed again. Reminders are the exception: each one is listed per interval AND
   * channel (24 hours by email, 24 hours by text, 1 hour by email...), because the patient chooses those channels separately.
   */
  @Get('mine')
  async mine(@CurrentUser() user: AuthUser): Promise<NotificationItem[]> {
    const rows: {
      id: string;
      kind: string;
      subject: string;
      body: string;
      raw_status: string;
      due: boolean;
      at: Date;
      sendAt: Date;
      dedupeKey: string;
      appointmentId: string;
      doctorName: string | null;
      date: string | null;
      startTime: string | null;
      endTime: string | null;
      channel: 'email' | 'sms';
    }[] = await this.dataSource.query(
      `SELECT n.id, n.kind, n.channel, n.subject, n.body, n.status AS raw_status, COALESCE(n.sent_at, n.send_at) AS at, n.send_at AS "sendAt",
              n.dedupe_key AS "dedupeKey", n.appointment_id AS "appointmentId", (n.send_at > now()) AS due,
              a.appointment_date AS "date", a.start_time AS "startTime", a.end_time AS "endTime", du.name AS "doctorName"
         FROM notifications n
         LEFT JOIN appointments a ON a.id = n.appointment_id
         LEFT JOIN doctors d ON d.id = a.doctor_id
         LEFT JOIN users du ON du.id = d.user_id
        WHERE n.recipient_user_id = $1 AND (n.channel = 'email' OR (n.kind = 'reminder' AND n.channel = 'sms')) AND n.status IN ('SENT', 'PENDING')
        ORDER BY COALESCE(n.sent_at, n.send_at) DESC
        LIMIT 200`,
      [user.id],
    );

    // A reminder is one per appointment, interval and channel. If an older duplicate is somehow still there, show it once (a sent
    // one outranks a pending one, then the earliest due), so the list can never show the same reminder twice. The 24-hour and
    // 1-hour reminders are different reminders and are both kept.
    const seen = new Map<string, number>();
    const unique: typeof rows = [];
    for (const row of rows) {
      const parsed = row.kind === 'reminder' ? parseReminderKey(row.dedupeKey) : null;
      if (!parsed) {
        unique.push(row);
        continue;
      }
      const slot = reminderSlot(row.appointmentId, parsed.hours, row.channel);
      const index = seen.get(slot);
      if (index === undefined) {
        seen.set(slot, unique.length);
        unique.push(row);
      } else {
        const current = unique[index];
        if ((row.raw_status === 'SENT' && current.raw_status !== 'SENT') || (row.raw_status === current.raw_status && row.sendAt < current.sendAt)) unique[index] = row;
      }
    }

    return unique.slice(0, 50).map((row): NotificationItem => ({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      body: row.body,
      status: row.raw_status === 'SENT' ? 'SENT' : row.due ? 'SCHEDULED' : 'QUEUED',
      at: row.at,
      sendAt: row.sendAt,
      intervalHours: (row.kind === 'reminder' ? parseReminderKey(row.dedupeKey)?.hours : undefined) ?? null,
      channel: row.channel,
      appointmentId: row.appointmentId,
      appointment: row.date && row.startTime && row.endTime && row.doctorName ? { doctorName: row.doctorName, date: row.date, startTime: row.startTime.slice(0, 5), endTime: row.endTime.slice(0, 5) } : null,
    }));
  }
}

const idParam = z.strictObject({ id: z.uuid() });

/** For an administrator to watch deliveries: the ones that gave up, and a way to put one back in the queue. */
@Controller('notifications/admin')
@UseGuards(AuthGuard)
@Roles('ADMIN')
export class NotificationsAdminController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('failed')
  failed() {
    return this.notifications.listFailed();
  }

  @Post(':id/retry')
  @HttpCode(200)
  retry(@Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>) {
    return this.notifications.requeueFailed(params.id);
  }
}

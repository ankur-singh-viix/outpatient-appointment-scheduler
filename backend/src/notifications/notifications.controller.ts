import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';

export interface NotificationItem {
  id: string;
  kind: string;
  subject: string;
  body: string;
  /** SENT: delivered. SCHEDULED: a reminder waiting for its time. QUEUED: due and about to go out (or being retried). */
  status: 'SENT' | 'SCHEDULED' | 'QUEUED';
  /** When it was sent, or when it is due. */
  at: Date;
  appointmentId: string;
}

@Controller('notifications')
@UseGuards(AuthGuard)
@Roles('PATIENT')
export class NotificationsController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** The messages CareSlot has sent the signed-in patient about their appointments, and the reminders still to come. Newest first. */
  @Get('mine')
  async mine(@CurrentUser() user: AuthUser): Promise<NotificationItem[]> {
    const rows: (Omit<NotificationItem, 'status'> & { raw_status: string; due: boolean })[] = await this.dataSource.query(
      `SELECT n.id, n.kind, n.subject, n.body, n.status AS raw_status, COALESCE(n.sent_at, n.send_at) AS at,
              n.appointment_id AS "appointmentId", (n.send_at > now()) AS due
         FROM notifications n
         JOIN appointments a ON a.id = n.appointment_id
         JOIN patients p ON p.id = a.patient_id
        WHERE p.user_id = $1 AND n.status IN ('SENT', 'PENDING')
        ORDER BY COALESCE(n.sent_at, n.send_at) DESC
        LIMIT 50`,
      [user.id],
    );
    return rows.map(({ raw_status, due, ...item }) => ({
      ...item,
      status: raw_status === 'SENT' ? 'SENT' : due ? 'SCHEDULED' : 'QUEUED',
    }));
  }
}

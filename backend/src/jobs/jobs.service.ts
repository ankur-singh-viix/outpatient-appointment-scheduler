import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { completeFinishedAppointments } from '../appointments/appointment-lifecycle.js';
import { loadConfig } from '../config.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { ScheduleChangeNotifier } from '../scheduling/schedule-change-notifier.service.js';

const EVERY_MS = 30_000;

/**
 * The background work that keeps payments and email moving without anyone clicking: release unpaid holds, retry refunds
 * Razorpay has not finished, and send due emails (reminders included). Each step is safe to run twice and to run on two
 * servers at once, so a slow run or a second instance cannot cause a duplicate. Turn it off with BACKGROUND_JOBS=false.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private timer?: NodeJS.Timeout;
  private running = false;
  private passes = 0;

  constructor(
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    private readonly scheduleChanges: ScheduleChangeNotifier,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    if (!loadConfig().backgroundJobs) return;
    this.timer = setInterval(() => void this.runOnce(), EVERY_MS);
    this.timer.unref(); // never keeps the process alive on its own
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One pass of every job. A failure in one is logged and never stops the others. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const pass = this.passes++;
    try {
      for (const [name, job] of [
        ['release unpaid holds', () => this.payments.expireHolds()],
        ['settle refunds', () => this.payments.settleRefunds()],
        ['ask patients whose appointments left the hours', () => this.scheduleChanges.drain()],
        ['send due emails', () => this.notifications.dispatchDue()],
        // Reminder upkeep is a scan of upcoming appointments, so it runs on the first pass after start-up and then every 10 minutes.
        ...(pass % 20 === 0
          ? ([
              ['repair reminders', () => this.notifications.maintainReminders()],
              // Patients who were asked to choose a new time and have not (at most two reminders, a cooldown apart)...
              ['remind patients who have not chosen a new time', () => this.scheduleChanges.remind()],
              // ...and patients who had no other time, told once when one opens up (also done at once when a doctor adds availability).
              ['tell patients when new times open up', () => this.scheduleChanges.recover()],
            ] as const)
          : []),
        // Appointments whose time has passed become COMPLETED (never CANCELLED or NO_SHOW), so past visits sit under Past everywhere.
        // One bounded statement, repeatable and safe on two servers at once; it runs on the first pass and then every 2 minutes.
        ...(pass % 4 === 0 ? ([['complete finished appointments', () => completeFinishedAppointments(this.dataSource, new Date(), loadConfig().clinicTimezone)]] as const) : []),
      ] as const) {
        await job().catch((error: Error) => this.logger.error(`Job "${name}" failed: ${error.message}`));
      }
    } finally {
      this.running = false;
    }
  }
}

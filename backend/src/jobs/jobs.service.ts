import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';

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
    try {
      for (const [name, job] of [
        ['release unpaid holds', () => this.payments.expireHolds()],
        ['settle refunds', () => this.payments.settleRefunds()],
        ['send due emails', () => this.notifications.dispatchDue()],
        // Reminder upkeep is a scan of upcoming appointments, so it runs on the first pass after start-up and then every 10 minutes.
        ...(this.passes++ % 20 === 0 ? ([['repair reminders', () => this.notifications.maintainReminders()]] as const) : []),
      ] as const) {
        await job().catch((error: Error) => this.logger.error(`Job "${name}" failed: ${error.message}`));
      }
    } finally {
      this.running = false;
    }
  }
}

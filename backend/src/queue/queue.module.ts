import { Module } from '@nestjs/common';
import { QueueController } from './queue.controller.js';
import { QueueService } from './queue.service.js';

/** Doctor-wise queue management: check-in, tokens, calling, completing and checkout. It reads and writes only its own tables (migration 015). */
@Module({
  controllers: [QueueController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}

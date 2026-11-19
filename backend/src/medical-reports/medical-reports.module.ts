import { Module } from '@nestjs/common';
import { MedicalReportsController } from './medical-reports.controller.js';
import { MedicalReportsService } from './medical-reports.service.js';
import { ReportStorage, S3ReportStorage } from './storage.js';

@Module({
  controllers: [MedicalReportsController],
  providers: [MedicalReportsService, { provide: ReportStorage, useClass: S3ReportStorage }],
  exports: [MedicalReportsService],
})
export class MedicalReportsModule {}

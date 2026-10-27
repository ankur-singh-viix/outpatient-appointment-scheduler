import { Module } from '@nestjs/common';
import { DoctorPortalController } from './doctor-portal.controller.js';
import { DoctorPortalService } from './doctor-portal.service.js';

@Module({
  controllers: [DoctorPortalController],
  providers: [DoctorPortalService],
})
export class DoctorPortalModule {}

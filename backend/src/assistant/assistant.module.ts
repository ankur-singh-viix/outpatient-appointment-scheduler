import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module.js';
import { DoctorPortalModule } from '../doctor-portal/doctor-portal.module.js';
import { DoctorsModule } from '../doctors/doctors.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AssistantActionsService } from './actions/assistant-actions.service.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { GeminiClient } from './llm/gemini-client.js';
import { LLM_CLIENT } from './llm/llm-client.js';

/**
 * The AI assistant. It reuses the existing services (doctors, appointments, doctor portal) for every fact it reports, and talks to the
 * model through LLM_CLIENT, so another provider is one new class and a one-line change here.
 */
@Module({
  imports: [DoctorsModule, AppointmentsModule, DoctorPortalModule, PaymentsModule],
  controllers: [AssistantController],
  exports: [AssistantActionsService],
  providers: [AssistantService, AssistantActionsService, GeminiClient, { provide: LLM_CLIENT, useExisting: GeminiClient }],
})
export class AssistantModule {}

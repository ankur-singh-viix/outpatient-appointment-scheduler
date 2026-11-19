import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { dateSchema } from '../scheduling/schemas.js';
import { PrescriptionsService } from './prescriptions.service.js';

const idParam = z.strictObject({ id: z.uuid() });
const medicationSchema = z.strictObject({
  name: z.string().trim().min(1, 'required').max(120),
  dosage: z.string().trim().max(80).optional(),
  frequency: z.string().trim().max(80).optional(),
  duration: z.string().trim().max(80).optional(),
  instructions: z.string().trim().max(200).optional(),
});
const bodySchema = z.strictObject({
  diagnosis: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  medications: z.array(medicationSchema).min(1).max(40),
});
const createSchema = bodySchema.extend({ appointmentId: z.uuid() });
const doctorListQuery = z.object({ date: dateSchema.optional(), status: z.enum(['DRAFT', 'FINALIZED']).optional() });
const receptionListQuery = z.object({ date: dateSchema.optional(), doctorId: z.uuid().optional() });
const noBody = z.strictObject({}).optional();

@Controller('prescriptions')
@UseGuards(AuthGuard)
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  // ---- Doctor ----

  @Get('doctor')
  @Roles('DOCTOR')
  listDoctor(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(doctorListQuery)) query: z.infer<typeof doctorListQuery>) {
    return this.prescriptions.listForDoctor(user, query);
  }

  @Get('doctor/:id')
  @Roles('DOCTOR')
  getDoctor(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>) {
    return this.prescriptions.getForDoctor(user, params.id);
  }

  @Post('doctor')
  @Roles('DOCTOR')
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>) {
    const { appointmentId, ...input } = body;
    return this.prescriptions.create(user, appointmentId, input);
  }

  @Put('doctor/:id')
  @Roles('DOCTOR')
  update(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(bodySchema)) body: z.infer<typeof bodySchema>,
  ) {
    return this.prescriptions.updateDraft(user, params.id, body);
  }

  @Post('doctor/:id/finalize')
  @HttpCode(200)
  @Roles('DOCTOR')
  finalize(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(noBody)) _body: z.infer<typeof noBody>,
  ) {
    return this.prescriptions.finalize(user, params.id);
  }

  // ---- Receptionist (finalized, read-only) ----

  @Get('reception')
  @Roles('RECEPTIONIST')
  listReception(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(receptionListQuery)) query: z.infer<typeof receptionListQuery>) {
    return this.prescriptions.listForReception(user, query);
  }

  @Get('reception/:id')
  @Roles('RECEPTIONIST')
  getReception(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>) {
    return this.prescriptions.getForReception(user, params.id);
  }

  // ---- Patient (own finalized only; patient identity from the session) ----

  @Get('mine')
  @Roles('PATIENT')
  listMine(@CurrentUser() user: AuthUser) {
    return this.prescriptions.listForPatient(user);
  }

  @Get('mine/:id')
  @Roles('PATIENT')
  getMine(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>) {
    return this.prescriptions.getForPatient(user, params.id);
  }
}

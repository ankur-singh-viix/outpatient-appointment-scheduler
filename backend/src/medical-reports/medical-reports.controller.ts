import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MEDICAL_REPORT_CATEGORIES } from '../database/entities/index.js';
import { dateSchema } from '../scheduling/schemas.js';
import { MEDICAL_REPORT_MAX_BYTES } from './file-validation.js';
import { MedicalReportsService } from './medical-reports.service.js';

const idParam = z.strictObject({ id: z.uuid() });
const patientIdParam = z.strictObject({ patientId: z.uuid() });
const categorySchema = z.enum(MEDICAL_REPORT_CATEGORIES);

const patientUploadFields = z.strictObject({
  category: categorySchema,
  reportDate: dateSchema,
});
const receptionUploadFields = patientUploadFields.extend({
  patientId: z.uuid(),
});

type UploadedMultipartFile = { buffer: Buffer; mimetype: string; originalname: string; size: number };

function requireFile(file: UploadedMultipartFile | undefined): UploadedMultipartFile {
  if (!file?.buffer?.length) throw new BadRequestException('Choose a PDF, JPG or PNG file to upload.');
  return file;
}

@Controller('medical-reports')
@UseGuards(AuthGuard)
export class MedicalReportsController {
  constructor(private readonly reports: MedicalReportsService) {}

  @Post('mine')
  @Roles('PATIENT')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MEDICAL_REPORT_MAX_BYTES, files: 1 } }))
  uploadMine(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedMultipartFile | undefined,
    @Body(new ZodValidationPipe(patientUploadFields)) body: z.infer<typeof patientUploadFields>,
  ) {
    const uploaded = requireFile(file);
    return this.reports.uploadForPatient(user, uploaded, body);
  }

  @Get('mine')
  @Roles('PATIENT')
  listMine(@CurrentUser() user: AuthUser) {
    return this.reports.listMine(user);
  }

  @Get('mine/:id/download')
  @Roles('PATIENT')
  downloadMine(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>) {
    return this.reports.downloadMine(user, params.id);
  }

  @Post('reception')
  @Roles('RECEPTIONIST')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MEDICAL_REPORT_MAX_BYTES, files: 1 } }))
  uploadReception(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedMultipartFile | undefined,
    @Body(new ZodValidationPipe(receptionUploadFields)) body: z.infer<typeof receptionUploadFields>,
  ) {
    const uploaded = requireFile(file);
    return this.reports.uploadForReception(user, uploaded, body);
  }

  @Get('doctor/patients/:patientId')
  @Roles('DOCTOR')
  listDoctor(
    @CurrentUser() user: AuthUser,
    @Param(new ZodValidationPipe(patientIdParam)) params: z.infer<typeof patientIdParam>,
  ) {
    return this.reports.listForDoctor(user, params.patientId);
  }

  @Get('doctor/:id/download')
  @Roles('DOCTOR')
  downloadDoctor(@CurrentUser() user: AuthUser, @Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>) {
    return this.reports.downloadForDoctor(user, params.id);
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminService } from './admin.service.js';

// Strict bodies: a request cannot say what role to create, only a name, an email and a clinic.
const createSchema = z.strictObject({
  name: z.string().trim().min(2, 'must be at least 2 characters').max(100, 'must be at most 100 characters'),
  email: z.email('must be a valid email address').max(255),
  clinicId: z.uuid('must be one of the listed clinics'),
});
const clinicSchema = z.strictObject({ clinicId: z.uuid('must be one of the listed clinics') });
const idParam = z.strictObject({ id: z.uuid() });

/** Administrators only. */
@Controller('admin')
@UseGuards(AuthGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** How email is being delivered (provider, development log, or off), for the page's status banner. */
  @Get('email-status')
  emailStatus() {
    return this.admin.emailStatus();
  }

  @Get('receptionists')
  list() {
    return this.admin.listReceptionists();
  }

  @Post('receptionists')
  create(@Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.admin.createReceptionist(body);
  }

  @Post('receptionists/:id/invitation')
  @HttpCode(200)
  resend(@Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>) {
    return this.admin.resendInvitation(params.id);
  }

  @Put('receptionists/:id/clinic')
  setClinic(@Param(new ZodValidationPipe(idParam)) params: z.infer<typeof idParam>, @Body(new ZodValidationPipe(clinicSchema)) body: z.infer<typeof clinicSchema>) {
    return this.admin.setClinic(params.id, body.clinicId);
  }
}

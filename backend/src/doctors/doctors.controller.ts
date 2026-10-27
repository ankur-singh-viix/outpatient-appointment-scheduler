import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { dateSchema } from '../scheduling/schemas.js';
import { DoctorsService } from './doctors.service.js';

const listDoctorsQuery = z.strictObject({
  search: z.string().max(100).optional(),
  specialtyId: z.uuid().optional(),
});

const slotsQuery = z.strictObject({ date: dateSchema });

// Public: patients can browse doctors and open slots before signing in.
@Controller()
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Get('specialties')
  specialties() {
    return this.doctors.specialties();
  }

  @Get('doctors')
  list(@Query(new ZodValidationPipe(listDoctorsQuery)) query: z.infer<typeof listDoctorsQuery>) {
    return this.doctors.list(query.search, query.specialtyId);
  }

  @Get('doctors/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.doctors.get(id);
  }

  @Get('doctors/:id/slots')
  slots(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(slotsQuery)) query: z.infer<typeof slotsQuery>,
  ) {
    return this.doctors.slots(id, query.date);
  }
}

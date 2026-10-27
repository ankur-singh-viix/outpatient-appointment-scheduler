import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates a request body, query or params against a Zod schema and returns the parsed value.
 * Usage: `@Body(new ZodValidationPipe(schema)) body: Input`.
 * Responds 400 with one readable message per problem, like `date: must be in YYYY-MM-DD format`.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException(
      result.error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)),
    );
  }
}

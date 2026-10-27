import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { ENTITIES } from './entities/index.js';

// Appointment dates and times are clinic-local calendar values, not instants.
// Keep them as plain strings instead of letting pg convert them to JS Dates.
const DATE_OID = 1082;
const TIME_OID = 1083;
pg.types.setTypeParser(DATE_OID, (value) => value);
pg.types.setTypeParser(TIME_OID, (value) => value);

function requiresTls(databaseUrl: string): boolean {
  return ['require', 'verify-ca', 'verify-full'].includes(new URL(databaseUrl).searchParams.get('sslmode') ?? '');
}

/**
 * Connects TypeORM to PostgreSQL and makes a repository for every entity injectable
 * (`@InjectRepository(Doctor)`) in any module. The schema itself is owned by the SQL files in
 * backend/db/migrations, so TypeORM never alters tables (synchronize is off).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        const url = loadConfig().databaseUrl;
        return {
          type: 'postgres' as const,
          url,
          entities: ENTITIES,
          synchronize: false,
          // Neon and most hosted databases require TLS (`?sslmode=require` in the URL). TypeORM only reads the
          // host, user and database from the URL, so turn TLS on explicitly, and keep verifying the certificate.
          ssl: requiresTls(url) ? { rejectUnauthorized: true } : undefined,
        };
      },
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}

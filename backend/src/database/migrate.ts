// CLI: `npm run db:migrate` (runs the compiled dist/database/migrate.js).
import { loadConfig, loadEnvFileIfPresent } from '../config.js';
import { runMigrations } from './migrator.js';

loadEnvFileIfPresent();
const applied = await runMigrations(loadConfig().databaseUrl);
console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database already up to date.');

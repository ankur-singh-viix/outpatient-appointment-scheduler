import { loadEnvFileIfPresent } from '../../src/config.js';
import { assertDisposableDatabase } from './test-database.js';

// Runs before every e2e spec file: the same .env loading the specs do, then the safety check, before anything connects.
loadEnvFileIfPresent();
assertDisposableDatabase(process.env.TEST_DATABASE_URL);
// Whatever a spec forgets to set, the app under test never falls back to the development database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

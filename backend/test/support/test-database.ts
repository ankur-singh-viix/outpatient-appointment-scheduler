/**
 * Guard for the e2e suite. Every e2e spec drops and rebuilds the "public" schema of TEST_DATABASE_URL, so that URL may only ever point at a
 * throwaway database: its name must end in "_test" (outpatient_test, never outpatient). Only the database name is ever put in a message,
 * never the URL, so no credentials can leak.
 */
export function databaseNameOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || null;
  } catch {
    return null;
  }
}

export function assertDisposableDatabase(url: string | undefined): string {
  if (!url) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
  const name = databaseNameOf(url);
  if (!name || !/^.+_test$/.test(name)) {
    throw new Error(
      `Refusing to run the e2e tests: TEST_DATABASE_URL points at the database "${name ?? 'unreadable'}", and these tests drop and rebuild its schema. ` +
        'Use a database whose name ends in "_test" (for example outpatient_test).',
    );
  }
  return name;
}

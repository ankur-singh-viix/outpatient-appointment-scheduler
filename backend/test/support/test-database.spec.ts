import { assertDisposableDatabase, databaseNameOf } from './test-database.js';

const url = (database: string, extra = '') => `postgres://someuser:s3cret-pass@localhost:5432/${database}${extra}`;

describe('assertDisposableDatabase: the e2e tests only ever reset a database named "..._test"', () => {
  it('accepts a database whose name ends in _test, with or without a query string', () => {
    expect(assertDisposableDatabase(url('outpatient_test'))).toBe('outpatient_test');
    expect(assertDisposableDatabase(url('anything_else_test', '?sslmode=disable'))).toBe('anything_else_test');
  });

  it.each(['outpatient', 'outpatient_testing', 'test', '_test', 'outpatient_test_old', 'production', 'Outpatient_TEST_backup'])('refuses "%s"', (database) => {
    expect(() => assertDisposableDatabase(url(database))).toThrow(/Refusing to run the e2e tests/);
  });

  it('refuses a URL with no database name, and one it cannot read', () => {
    expect(() => assertDisposableDatabase('postgres://someuser:s3cret-pass@localhost:5432')).toThrow(/Refusing/);
    expect(() => assertDisposableDatabase('not a url at all')).toThrow(/unreadable/);
  });

  it('says what to set when there is no URL at all', () => {
    expect(() => assertDisposableDatabase(undefined)).toThrow('Set TEST_DATABASE_URL');
    expect(() => assertDisposableDatabase('')).toThrow('Set TEST_DATABASE_URL');
  });

  it('never puts the user, the password or the host in a message, only the database name', () => {
    for (const bad of [url('outpatient'), 'postgres://someuser:s3cret-pass@localhost:5432', 'not a url s3cret-pass']) {
      try {
        assertDisposableDatabase(bad);
      } catch (error) {
        expect((error as Error).message).not.toMatch(/someuser|s3cret-pass|localhost|5432/);
      }
    }
  });
});

describe('databaseNameOf', () => {
  it('reads the database name from the path', () => {
    expect(databaseNameOf(url('outpatient_test'))).toBe('outpatient_test');
    expect(databaseNameOf(url('my%20db_test'))).toBe('my db_test');
  });
});

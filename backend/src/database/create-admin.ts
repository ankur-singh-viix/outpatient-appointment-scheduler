// CLI: `npm run admin:create -- --name "Asha Menon" --email asha@example.com`
// (production: `npm run admin:create:prod -- ...`). Creates one administrator in the database named by DATABASE_URL.
//
// The password is typed at a hidden prompt (twice), so it never appears in the command line, the shell history or process lists.
// For automation with no terminal, set ADMIN_PASSWORD in the environment instead. It never prints the password.
import pg from 'pg';
import { loadConfig, loadEnvFileIfPresent } from '../config.js';
import { MIN_ADMIN_PASSWORD, createAdminAccount } from './admin-account.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Reads a line from the terminal without echoing it. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('No terminal to ask for a password. Run this in a terminal, or set ADMIN_PASSWORD.');
  const password = await askHidden(`Password (at least ${MIN_ADMIN_PASSWORD} characters): `);
  if (password !== (await askHidden('Repeat the password: '))) throw new Error('The passwords did not match.');
  return password;
}

loadEnvFileIfPresent();
const name = option('name');
const email = option('email');
if (!name || !email) {
  console.error('Usage: npm run admin:create -- --name "Full Name" --email someone@example.com');
  process.exit(1);
}

const client = new pg.Client({ connectionString: loadConfig().databaseUrl });
try {
  const password = await readPassword();
  await client.connect();
  const result = await createAdminAccount(client, { name, email, password });
  if (result === 'exists') {
    console.error(`An account with ${email} already exists, so nothing was changed. Use a different email.`);
    process.exitCode = 1;
  } else {
    console.log(`Created the administrator ${email}. They can sign in at /login with the password you just chose.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}

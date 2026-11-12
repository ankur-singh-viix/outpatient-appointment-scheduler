import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Automated tests must never reach a real email provider, whatever is in the developer's backend/.env.
    env: { BREVO_API_KEY: '', RESEND_API_KEY: '', EMAIL_PROVIDER: '' },
    // The e2e files share one test database (each resets it), so they must not run at the same time.
    fileParallelism: false,
  },
});

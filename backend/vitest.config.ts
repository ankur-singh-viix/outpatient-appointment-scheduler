import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Automated tests must never reach a real email provider, whatever is in the developer's backend/.env.
    env: { BREVO_API_KEY: '', RESEND_API_KEY: '', EMAIL_PROVIDER: '' },
  },
});

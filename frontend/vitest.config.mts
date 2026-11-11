import { defineConfig } from 'vitest/config';

// The voice logic is plain TypeScript with the browser's speech APIs injected, so it is tested in Node with fakes (no DOM needed).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});

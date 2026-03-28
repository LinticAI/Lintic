import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  // Backend packages — node environment, no globals
  {
    test: {
      name: 'node',
      include: [
        'packages/core/src/**/*.test.ts',
        'packages/adapters/src/**/*.test.ts',
        'packages/backend/src/**/*.test.ts',
      ],
      environment: 'node',
    },
  },
  // Frontend package — jsdom environment, globals + jest-dom setup
  {
    test: {
      name: 'frontend',
      include: ['packages/frontend/src/**/*.test.tsx'],
      environment: 'jsdom',
      setupFiles: ['./packages/frontend/src/test-setup.ts'],
      globals: true,
    },
  },
]);

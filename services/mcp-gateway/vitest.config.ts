import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript source (the `@poc/source` export condition).
export default defineConfig({
  resolve: { conditions: ['@poc/source'] },
  ssr: { resolve: { conditions: ['@poc/source'] } },
});

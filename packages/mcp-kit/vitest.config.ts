import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@poc/source'] },
  ssr: { resolve: { conditions: ['@poc/source'] } },
});

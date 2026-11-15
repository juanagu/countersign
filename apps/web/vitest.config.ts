import { defineConfig } from 'vitest/config';

// The unit tests render to strings in Node. CopilotKit imports its own CSS, so it is inlined
// through Vite (which drops CSS with `css: false`) instead of being loaded by Node.
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'], // e2e/ belongs to Playwright
    css: false,
    server: { deps: { inline: [/@copilotkit\//] } },
  },
});

import { defineConfig } from "vitest/config";

// Tests live in test/ at the repo root; vite.config.ts points at web/ for the UI build.
export default defineConfig({
  test: { root: ".", include: ["test/**/*.test.ts"] },
});

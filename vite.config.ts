import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The web UI. `pnpm build` puts it in dist/web, which the local CLI and the server both serve.
// Tests live in test/ at the repo root, so `test.root` points back there.
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "web/src") } },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4545" } },
  test: { root: import.meta.dirname, include: ["test/**/*.test.ts"] },
});

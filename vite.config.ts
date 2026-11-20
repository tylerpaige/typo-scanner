import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: { port: 5175, strictPort: true },
  build: { target: "safari16" },
  test: { include: ["test/**/*.test.ts"] },
});

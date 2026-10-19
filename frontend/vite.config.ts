import { defineConfig } from "vitest/config";
export default defineConfig({
  server: { proxy: { "/api": "http://127.0.0.1:8080" } },
  test: { environment: "jsdom", maxWorkers: 1, include: ["src/**/*.test.ts"] },
  build: { target: "es2023" },
});

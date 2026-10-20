/// <reference types="node" />

import process from "node:process";
import { defineConfig } from "@playwright/test";
import {
  assertNoAmbientPostgres,
  browserFixtureBaseUrl,
  browserFixtureEnvironment,
} from "../scripts/browser-fixture-server.mjs";
import { readCurrentBinary, shellCommand } from "../scripts/server-binary.mjs";

assertNoAmbientPostgres(process.env);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for real PostgreSQL browser tests");
const databaseEnvironment = browserFixtureEnvironment(
  process.env,
  browserFixtureBaseUrl(process.env.DATABASE_URL),
);
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  retries: 0,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:18082", trace: "retain-on-failure" },
  webServer: [
    {
      command: shellCommand(readCurrentBinary()),
      url: "http://127.0.0.1:18082/readyz",
      reuseExistingServer: false,
      env: {
        ...databaseEnvironment,
        NAVARCHNET_AUTH_MODE: "demo",
        NAVARCHNET_AWS_READ_ONLY: "false",
        NAVARCHNET_ADMIN_TOKEN: "browser-test-admin-credential-free-local-only",
        NAVARCHNET_READER_TOKEN: "browser-test-reader-credential-free-local-only",
        NAVARCHNET_BIND: "127.0.0.1:18082",
        NAVARCHNET_STATIC_DIR: "dist",
        RUST_LOG: "warn",
      },
    },
    {
      command: "node ../scripts/browser-fixture-server.mjs",
      url: "http://127.0.0.1:18083/readyz",
      reuseExistingServer: false,
      env: {
        ...databaseEnvironment,
        NAVARCHNET_AUTH_MODE: "demo",
        NAVARCHNET_AWS_READ_ONLY: "false",
        NAVARCHNET_ADMIN_TOKEN: "browser-test-admin-credential-free-local-only",
        NAVARCHNET_READER_TOKEN: "browser-test-reader-credential-free-local-only",
        NAVARCHNET_STATIC_DIR: "dist",
        RUST_LOG: "warn",
      },
    },
  ],
});

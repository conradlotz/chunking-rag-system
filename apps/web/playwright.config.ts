import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const chromium = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const fixtureDb = process.env.LAB_FIXTURE_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:54329/bench";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { launchOptions: { executablePath: chromium, args: ["--no-sandbox"] }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "fixture", testMatch: /app\.spec\.ts/, use: { baseURL: "http://localhost:3100" } },
    { name: "auth", testMatch: /auth\.spec\.ts/, use: { baseURL: "http://localhost:3101" } },
  ],
  webServer: [
    {
      // Development fixture: local Postgres through the same lab_* functions, no login. Load it first with
      // pipeline/tests/fixtures/load_dev_fixture.py.
      command: "npx next dev -p 3100",
      url: "http://localhost:3100/method",
      reuseExistingServer: true,
      timeout: 120_000,
      env: { LAB_FIXTURE: "1", LAB_FIXTURE_DATABASE_URL: fixtureDb, NEXT_TELEMETRY_DISABLED: "1" },
    },
    {
      // Production-like: no fixture, so every page needs a Supabase session. The URL is unreachable on purpose:
      // the tests only exercise the signed-out paths, which need no network.
      command: "npx next dev -p 3101 --turbopack",
      url: "http://localhost:3101/login",
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        LAB_FIXTURE: "",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_not_a_real_key",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});

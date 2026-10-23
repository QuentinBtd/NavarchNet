import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { repository } from "./server-binary.mjs";
import { browserFixtureBaseUrl, browserFixtureEnvironment, isolatedDatabaseUrl } from "./browser-fixture-server.mjs";

test("browser fixture database binding accepts only generated schemas on loopback PostgreSQL", () => {
  const schema = `test_${"a".repeat(32)}`;
  const url = new URL(isolatedDatabaseUrl("postgres://fixture:private-fixture@127.0.0.1:55432/postgres?sslmode=disable", schema));
  assert.equal(url.searchParams.get("options"), `-csearch_path=${schema}`);
  assert.equal(url.searchParams.getAll("options").length, 1);
  assert.equal(url.searchParams.get("sslmode"), "disable");
  assert.equal(url.username, "fixture");
  const base = new URL(browserFixtureBaseUrl("postgres://fixture:dummy@localhost/postgres?ssl%6dode=disable"));
  assert.equal(base.hostname, "127.0.0.1");
  assert.equal(base.search, "?sslmode=disable");
  assert(!base.searchParams.has("options"));
  for (const invalid of ["public", `${schema};drop`, "test_not_hex", ` ${schema}`]) {
    assert.throws(() => isolatedDatabaseUrl("postgres://fixture@localhost/postgres", invalid), /schema/);
  }
  for (const base of ["https://127.0.0.1/", "postgres://fixture@remote.example/postgres", "not-a-url"]) {
    assert.throws(() => isolatedDatabaseUrl(base, schema), (error) => {
      assert(!error.message.includes(base));
      return true;
    });
  }
});

test("browser fixture rejects SQLx routing overrides including encoded or duplicate keys", () => {
  const schema = `test_${"a".repeat(32)}`;
  for (const query of [
    "host=remote.example", "hostaddr=192.0.2.1", "host=127.0.0.1&host=remote.example",
    "h%6fst=remote.example", "%68ostaddr=192.0.2.1", "port=6543", "dbname=other",
    "user=other", "password=other", "unknown=ignored-by-sqlx",
  ]) {
    assert.throws(() => isolatedDatabaseUrl(`postgres://fixture:dummy@127.0.0.1:55432/postgres?${query}`, schema), /parameter/);
  }
});

test("browser fixture rejects every caller-controlled SQLx startup option before seeding", () => {
  const schema = `test_${"a".repeat(32)}`;
  for (const query of [
    "options=-csearch_path%3Dpublic", "options%5Bsearch_path%5D=public",
    "options=-cstatement_timeout%3D5000&options%5Bsearch_path%5D=public",
    "options=first&options=second", "opt%69ons%5Bsearch_path%5D=public",
    "options[search_path]=public&options[search_path]=other", "sslmode=disable&sslmode=require",
  ]) {
    assert.throws(() => isolatedDatabaseUrl(`postgres://fixture:dummy@127.0.0.1:55432/postgres?${query}`, schema), /parameter/);
  }
});

test("browser fixture gives seed and server explicit connection data without ambient PG overrides", () => {
  const result = browserFixtureEnvironment({ PGHOST: "remote.example", PGOPTIONS: "-csearch_path=public", PGPASSWORD: "ambient", PGSSLKEY: "/unrelated/key", PATH: "tools", DATABASE_URL: "unvalidated" }, "validated");
  assert.deepEqual(result, { PATH: "tools", DATABASE_URL: "validated" });
  for (const base of ["postgres://fixture@127.0.0.1/postgres", "postgres://fixture:dummy@127.0.0.1/", "postgres://fixture:dummy@127.0.0.1///"]) {
    assert.throws(() => browserFixtureBaseUrl(base), /explicit/);
  }
});

test("actual Playwright configuration rejects ambient PostgreSQL settings before either server can start", () => {
  for (const [key, value] of [["PGOPTIONS", "-csearch_path=public"], ["PGPORT", "6543"], ["PGSSLKEY", "/unrelated/fixture-key"]]) {
    const result = spawnSync(process.execPath, [join(repository, "frontend/node_modules/@playwright/test/cli.js"), "test", "--list", "--config", join(repository, "frontend/playwright.config.ts")], {
      cwd: repository,
      env: { ...browserFixtureEnvironment(process.env, "postgres://fixture:dummy@127.0.0.1:55432/postgres"), [key]: value },
      encoding: "utf8", timeout: 15000,
    });
    assert.notEqual(result.status, 0, "Ambient PostgreSQL configuration reached Playwright server setup");
    assert.match(`${result.stdout}${result.stderr}`, /Ambient PostgreSQL settings are forbidden/, "The actual config must fail on the boundary guard, not an unrelated missing artifact");
  }
});

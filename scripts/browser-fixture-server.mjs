import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCurrentBinary, repository } from "./server-binary.mjs";

export function browserFixtureBaseUrl(base) {
  let url;
  try { url = new URL(base); } catch { throw new Error("Invalid browser fixture database configuration"); }
  assert(["postgres:", "postgresql:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Browser fixture requires loopback PostgreSQL");
  assert(url.username && url.password && url.pathname.replace(/^\/+/, "").length > 0, "Browser fixture requires explicit database and disposable credentials");
  assert(!url.hash, "Browser fixture database fragments are not supported");
  // SQLx applies query host/hostaddr and accumulates options/options[...] after the authority.
  // Reject every driver override, including unknown keys and percent-decoded duplicates.
  const parameters = [...url.searchParams];
  const seen = new Set();
  for (const [key, value] of parameters) {
    assert(key === "sslmode" && !seen.has(key), "Unsupported or duplicate browser fixture database parameter");
    assert(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(value), "Invalid browser fixture database parameter");
    seen.add(key);
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  url.search = "";
  for (const [key, value] of parameters) url.searchParams.append(key, value);
  return url.toString();
}
export function browserFixtureEnvironment(environment, database) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("PG"))), DATABASE_URL: database };
}
export function assertNoAmbientPostgres(environment) {
  // Playwright overlays webServer.env on process.env; omission alone cannot unset inherited keys.
  if (Object.keys(environment).some((key) => key.startsWith("PG"))) {
    throw new Error("Ambient PostgreSQL settings are forbidden in browser acceptance");
  }
}
export function isolatedDatabaseUrl(base, schema) {
  assert(/^test_[0-9a-f]{32}$/.test(schema), "Invalid generated browser fixture schema");
  const url = new URL(browserFixtureBaseUrl(base));
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

function main() {
  const binary = readCurrentBinary();
  // Both processes receive the same validated base, never the original untrusted URL/PG defaults.
  const base = browserFixtureBaseUrl(process.env.DATABASE_URL);
  const seed = spawnSync("cargo", ["run", "--quiet", "--locked", "--example", "browser_fixture_seed", "--", "--isolated-browser-fixture"], {
    cwd: repository, env: browserFixtureEnvironment(process.env, base), encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
  });
  // Never echo a database client's diagnostics, which could include connection details.
  assert.equal(seed.status, 0, "Isolated browser fixture seeding failed; inspect setup without printing credentials");
  const { schema } = JSON.parse(seed.stdout);
  const database = isolatedDatabaseUrl(base, schema);
  assert.equal(readCurrentBinary(), binary, "Current server artifact changed during browser fixture seeding");
  const child = spawn(binary, [], {
    stdio: "inherit",
    env: { ...browserFixtureEnvironment(process.env, database), NAVARCHNET_AUTH_MODE: "demo", NAVARCHNET_AWS_READ_ONLY: "false", NAVARCHNET_BIND: "127.0.0.1:18083" },
  });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; child.kill("SIGTERM"); });
  child.on("error", () => { console.error("Current server failed to start for isolated browser fixture"); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0)); });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

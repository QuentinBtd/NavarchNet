// Explicit real-binary integration regression; never an emulator or a fabricated server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { binaryDigest, cargoTargetDirectory, readCurrentBinary, receiptPath, repository } from "./server-binary.mjs";

assert(process.env.DATABASE_URL, "Real disposable PostgreSQL is mandatory");
assert(process.env.NAVARCHNET_OBSOLETE_BINARY, "Supply an actual retained pre-GET-/aws/accounts server artifact");
const target = cargoTargetDirectory();
assert.notEqual(target, join(repository, "target"), "Select a distinct CARGO_TARGET_DIR");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? join(repository, ".local"), "navarchnet-target-regression-"));
const obsolete = join(scratch, "obsolete-navarchnet");
copyFileSync(resolve(repository, process.env.NAVARCHNET_OBSOLETE_BINARY), obsolete);
const defaultBinary = join(repository, "target", "debug", "navarchnet");
const defaultReceipt = receiptPath(join(repository, "target"));
const hadBinary = existsSync(defaultBinary), hadReceipt = existsSync(defaultReceipt);
if (hadBinary) copyFileSync(defaultBinary, join(scratch, "original-navarchnet"));
if (hadReceipt) copyFileSync(defaultReceipt, join(scratch, "original-receipt.json"));
function run(...args) {
  const result = spawnSync("mise", args, { cwd: repository, env: { ...process.env, NAVARCHNET_BINARY: defaultBinary }, stdio: "inherit" });
  assert.equal(result.status, 0, `mise ${args.join(" ")} failed: ${result.error ?? result.signal ?? result.status}`);
}
let child;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exit = new Promise((done) => child.once("exit", done));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.kill("SIGTERM");
  await exit;
  clearTimeout(timer);
}
try {
  run("run", "build");
  const current = readCurrentBinary(target);
  const currentHash = binaryDigest(current), obsoleteHash = binaryDigest(obsolete);
  assert.notEqual(currentHash, obsoleteHash, "The obsolete and current binaries must actually differ");
  mkdirSync(dirname(defaultBinary), { recursive: true });
  copyFileSync(obsolete, defaultBinary);
  const reservation = createServer();
  await new Promise((done, fail) => reservation.once("error", fail).listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const base = `http://127.0.0.1:${port}`;
  const token = "regression-local-only-credential-free-admin";
  child = spawn(defaultBinary, [], { cwd: repository, env: {
    ...process.env, NAVARCHNET_AUTH_MODE: "demo", NAVARCHNET_AWS_READ_ONLY: "false",
    NAVARCHNET_ADMIN_TOKEN: token, NAVARCHNET_READER_TOKEN: "regression-local-only-credential-free-reader",
    NAVARCHNET_BIND: `127.0.0.1:${port}`, RUST_LOG: "warn",
  }, stdio: ["ignore", "inherit", "inherit"] });
  let launchError;
  child.once("error", (error) => { launchError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(!launchError && child.exitCode === null && !child.signalCode, "Obsolete fixture must really start");
    try { ready = (await fetch(`${base}/readyz`)).ok; } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert(ready, "Obsolete real server must reach database-backed readiness");
  const old = await fetch(`${base}/api/v1/aws/accounts`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(old.status, 405, "The actual obsolete fixture must lack the new GET contract");
  await stop();
  console.log(JSON.stringify({ regression_fixture: { default_binary: defaultBinary, obsolete_sha256: obsoleteHash, obsolete_get_status: old.status, current_binary: current, current_sha256: currentHash, target_directory: target } }));
  // Both real harnesses require the new GET contract. The deliberately stale override must not win.
  run("run", "smoke");
  run("run", "browser");
  assert.equal(binaryDigest(defaultBinary), obsoleteHash, "The obsolete default artifact must remain in place throughout qualification");
  console.log(JSON.stringify({ binary_target_regression: "pass", http_crash_smoke: true, real_playwright: true, obsolete_default_retained: true, different_real_binaries: true }));
} finally {
  await stop();
  if (hadBinary) copyFileSync(join(scratch, "original-navarchnet"), defaultBinary);
  else rmSync(defaultBinary, { force: true });
  if (hadReceipt) copyFileSync(join(scratch, "original-receipt.json"), defaultReceipt);
  else rmSync(defaultReceipt, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}

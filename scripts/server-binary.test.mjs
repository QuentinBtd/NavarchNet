import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { binaryDigest, readCurrentBinary, receiptPath, repository, shellCommand } from "./server-binary.mjs";

// Unit fixtures are data only. The explicit binary-target-regression task exercises real servers.
function fixture(t) {
  const scratch = process.env.TMPDIR ?? join(repository, ".local");
  mkdirSync(scratch, { recursive: true });
  const target = mkdtempSync(join(scratch, "navarchnet-binary-unit-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const binary = join(target, "binary with 'quote' and $literal");
  writeFileSync(binary, "unit fixture, never executed\n");
  chmodSync(binary, 0o700);
  const receipt = { target_directory: target, executable: binary, sha256: binaryDigest(binary) };
  const save = () => writeFileSync(receiptPath(target), JSON.stringify(receipt));
  save();
  return { target, binary, receipt, save };
}

test("returns the exact absolute Cargo artifact, including spaces and quotes", (t) => {
  const { target, binary } = fixture(t);
  assert.equal(readCurrentBinary(target), binary);
});
test("missing receipt fails instead of falling back to a default binary", (t) => {
  const { target } = fixture(t);
  rmSync(receiptPath(target));
  assert.throws(() => readCurrentBinary(target), /ENOENT/);
});
test("a receipt for another target directory is rejected", (t) => {
  const f = fixture(t);
  f.receipt.target_directory = join(f.target, "other"); f.save();
  assert.throws(() => readCurrentBinary(f.target), /different Cargo target/);
});
test("relative artifact paths are rejected", (t) => {
  const f = fixture(t);
  f.receipt.executable = "target/debug/navarchnet"; f.save();
  assert.throws(() => readCurrentBinary(f.target), /must be absolute/);
});
test("replacement of an already recorded executable is rejected", (t) => {
  const f = fixture(t);
  writeFileSync(f.binary, "a different unit fixture\n");
  assert.throws(() => readCurrentBinary(f.target), /changed since cargo build/);
});
test("the Playwright shell command preserves literal quotes and expansion characters", () => {
  const value = "/a directory/'quoted'/$HOME/`not-executed`/$(not-executed)";
  const result = spawnSync("sh", ["-c", `printf '%s' ${shellCommand(value)}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, value);
});

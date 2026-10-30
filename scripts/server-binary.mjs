import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function cargoTargetDirectory() {
  // Cargo, not the caller's working directory or a guessed debug path, owns this value.
  const result = spawnSync("cargo", ["metadata", "--locked", "--offline", "--no-deps", "--format-version=1"], {
    cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `Cargo metadata failed: ${result.error ?? result.stderr}`);
  const target = JSON.parse(result.stdout).target_directory;
  assert(isAbsolute(target), "Cargo must return an absolute target directory");
  return target;
}
export const receiptPath = (target) => join(target, "navarchnet-current-build.json");
export const binaryDigest = (binary) => createHash("sha256").update(readFileSync(binary)).digest("hex");
export function readCurrentBinary(target = cargoTargetDirectory()) {
  const receipt = JSON.parse(readFileSync(receiptPath(target), "utf8"));
  assert.equal(receipt.target_directory, target, "Build receipt belongs to a different Cargo target");
  assert(isAbsolute(receipt.executable), "Build receipt executable must be absolute");
  accessSync(receipt.executable, constants.X_OK);
  assert.equal(binaryDigest(receipt.executable), receipt.sha256, "Server changed since cargo build; rebuild before qualification");
  return receipt.executable;
}
export function smokeBinary() {
  // Explicit distribution qualification is separate from the source gate, which clears this override.
  if (process.env.NAVARCHNET_BINARY) {
    const binary = resolve(repository, process.env.NAVARCHNET_BINARY);
    accessSync(binary, constants.X_OK);
    return binary;
  }
  return readCurrentBinary();
}
export const shellCommand = (binary) => `'${binary.replaceAll("'", "'\\''")}'`;

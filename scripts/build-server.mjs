import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { binaryDigest, cargoTargetDirectory, receiptPath, repository } from "./server-binary.mjs";

const target = cargoTargetDirectory();
const receipt = receiptPath(target);
// A failed build must never leave a previous receipt looking current.
rmSync(receipt, { force: true });
const build = spawnSync("cargo", ["build", "--locked", "--bin", "navarchnet", "--message-format=json-render-diagnostics"], {
  cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024,
});
assert.equal(build.status, 0, `Server build failed: ${build.error ?? build.signal ?? build.status}`);
const artifacts = build.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .filter((item) => item.reason === "compiler-artifact" && item.target.name === "navarchnet" && item.target.kind.includes("bin") && item.executable);
assert.equal(artifacts.length, 1, "Expected one actual Cargo server executable artifact");
const executable = artifacts[0].executable;
assert(isAbsolute(executable), "Cargo executable artifact must be absolute");
const result = { target_directory: target, executable, sha256: binaryDigest(executable) };
const temporary = `${receipt}.${process.pid}.tmp`;
try {
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, receipt);
} finally { rmSync(temporary, { force: true }); }
console.log(JSON.stringify({ server_build: result }));

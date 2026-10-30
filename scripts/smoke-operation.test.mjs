import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { compileFunction } from "node:vm";

// Exercise the actual smoke adapter without its top-level server/auth/database startup.
// The absent helper is allowed only so the original inline waiter can execute RED.
const helper = new URL("./smoke-operation.mjs", import.meta.url);
const waitForOperation = existsSync(helper) ? (await import(helper.href)).waitForOperation : undefined;
function smokeWaiter(terminalAt, terminal = "succeeded") {
  let elapsed = 0, reads = 0;
  const source = readFileSync(new URL("./smoke.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function complete(");
  const end = source.indexOf("\ntry {", start);
  assert(start >= 0 && end > start, "Actual smoke completion adapter must remain covered");
  const complete = compileFunction(`${source.slice(start, end)}; return complete;`,
    ["api", "assert", "setTimeout", "waitForOperation"])(async path => {
      assert.equal(path, "/operations/fixture-operation"); reads++;
      return { id: "fixture-operation", status: elapsed >= terminalAt ? terminal : "running" };
    }, assert, (done, ms) => { elapsed += ms; done(); }, waitForOperation);
  return { complete, get elapsed() { return elapsed; }, get reads() { return reads; } };
}

test("SIGKILL recovery reserves the existing claim lease before the ordinary progress budget", async () => {
  // Virtual response/timer fixture only: not real PostgreSQL, SIGKILL or AWS evidence.
  const leaseAndSevenTicks = 15_000 + 7 * 100;
  const waiter = smokeWaiter(leaseAndSevenTicks);
  const operation = await waiter.complete("fixture-operation", "succeeded", true);
  assert.equal(operation.status, "succeeded");
  assert.equal(waiter.elapsed, leaseAndSevenTicks);
});

test("ordinary completion keeps the original 150 polls and refuses late success", async () => {
  const waiter = smokeWaiter(15_000 + 100);
  await assert.rejects(waiter.complete("fixture-operation", "succeeded"), /did not finish/);
  assert.equal(waiter.elapsed, 15_000);
  assert.equal(waiter.reads, 150);
});

test("a stuck recovery remains bounded without renewing the lease allowance", async () => {
  const waiter = smokeWaiter(Infinity);
  await assert.rejects(waiter.complete("fixture-operation", "succeeded", true), /did not finish/);
  assert.equal(waiter.elapsed, 15_000 + 15_000);
  assert.equal(waiter.reads, 150 + 150);
});

test("an unexpected terminal result still fails immediately in both modes", async () => {
  for (const recovering of [false, true]) {
    const waiter = smokeWaiter(0, "failed");
    await assert.rejects(waiter.complete("fixture-operation", "succeeded", recovering), /failed.*succeeded/s);
    assert.equal(waiter.elapsed, 0);
    assert.equal(waiter.reads, 1);
  }
});

test("claim policy and actual SIGKILL-only adapter allowance stay explicitly bound", async () => {
  const { SMOKE_CLAIM_LEASE_MS } = await import(helper.href);
  const store = readFileSync(new URL("../crates/navarchnet/src/store.rs", import.meta.url), "utf8");
  const claim = store.match(/lease_until=clock_timestamp\(\)\+interval '(\d+) seconds'/);
  assert(claim, "Source claim lease must be reviewed if its representation changes");
  assert.equal(SMOKE_CLAIM_LEASE_MS, Number(claim[1]) * 1000);
  const source = readFileSync(new URL("./smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /await stop\("SIGKILL"\); start\(\); await ready\(\);\s+await complete\(operation.id, "succeeded", true\)/);
  assert.match(source, /await complete\(partial.id, "partial"\)/);
  assert.equal([...source.matchAll(/await complete\([^\n]+true\)/g)].length, 1);
});

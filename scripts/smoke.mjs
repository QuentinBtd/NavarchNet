import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { smokeBinary } from "./server-binary.mjs";

const database = process.env.DATABASE_URL;
assert(database, "DATABASE_URL is required; real PostgreSQL must be reachable");
const admin = randomBytes(32).toString("hex");
const reader = randomBytes(32).toString("hex");
const base = "http://127.0.0.1:18081";
const binary = smokeBinary();
let child;
function start() {
  child = spawn(binary, [], { env: { ...process.env, NAVARCHNET_AUTH_MODE: "demo", NAVARCHNET_AWS_READ_ONLY: "false", NAVARCHNET_ADMIN_TOKEN: admin, NAVARCHNET_READER_TOKEN: reader, NAVARCHNET_BIND: "127.0.0.1:18081", RUST_LOG: "warn" }, stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (error) => { console.error(error); process.exitCode = 1; });
}
async function stop(signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill(signal); await exited;
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode) throw new Error("Application exited before readiness");
    try { if ((await fetch(`${base}/readyz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Application readiness timed out");
}
async function api(path, body, token = admin, status = 200) {
  const response = await fetch(`${base}/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { Connection: "close", Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, status, `${path}: ${await response.clone().text()}`);
  return status === 204 ? undefined : response.json();
}
async function complete(id, expected) {
  for (let i = 0; i < 150; i++) {
    const op = await api(`/operations/${id}`);
    if (["succeeded", "partial", "failed"].includes(op.status)) { assert.equal(op.status, expected); return op; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Operation ${id} did not finish`);
}
try {
  start(); await ready();
  const health = spawnSync(binary, ["--healthcheck"], { env: { ...process.env, NAVARCHNET_BIND: "127.0.0.1:18081" }, timeout: 5000 });
  assert.equal(health.status, 0, `Healthcheck failed: ${health.stderr}`);
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /NavarchNet/);
  await api("/snapshot", undefined, "invalid", 401);
  const snapshot = await api("/snapshot", undefined, reader);
  assert.deepEqual(await api("/aws/accounts", undefined, reader), snapshot.aws_accounts);
  await api("/accounts", { name: "Forbidden", provider: "fake", role_arn: "fake:role" }, reader, 403);
  const account = await api("/accounts", { name: "Smoke application", provider: "fake", role_arn: "fake:smoke-role" });
  const inventory = await api(`/accounts/${account.id}/discover`, {});
  const network = await api("/networks", { name: "Smoke regional egress" });
  const request = { account_id: account.id, vpc_id: inventory.vpc_id, subnet_ids: inventory.subnets.map((s) => s.id), network_id: network.id, allow_application_traffic: false };
  const plan = await api("/plans", request);
  assert.equal(plan.actions.at(-1).kind, "spoke_default_route");
  assert.equal(plan.digest.length, 64);
  const operation = await api(`/plans/${plan.id}/apply`, { fault: "throttle" });
  const beforeRestart = await api(`/operations/${operation.id}`);
  assert(beforeRestart.step < plan.actions.length, "Crash-recovery smoke must interrupt an unfinished operation");
  await stop("SIGKILL"); start(); await ready();
  await complete(operation.id, "succeeded");
  assert.equal((await api(`/plans/${plan.id}/apply`, { fault: "none" })).id, operation.id);
  const observation = await api(`/operations/${operation.id}/observation`);
  assert.equal(observation.configuration, "simulated_converged");
  assert.match(observation.active_probe, /Not tested/); assert.equal(observation.drift, false);
  const events = await api(`/operations/${operation.id}/events`); assert(events.length >= plan.actions.length + 1);
  await api(`/operations/${operation.id}/demo-drift`, {}, admin, 204);
  assert.equal((await api(`/operations/${operation.id}/observation`)).drift, true);
  const repair = await api("/plans", request);
  const partial = await api(`/plans/${repair.id}/apply`, { fault: "partial_failure" });
  assert((await complete(partial.id, "partial")).step > 0);
  assert((await api("/audit", undefined, reader)).some((e) => e.event === "plan_applied"));
  const refreshed = await api("/snapshot", undefined, reader); assert.equal(refreshed.role, "read_only");
  console.log(JSON.stringify({ result: "pass", postgres: "real", account_id: account.id, plan_id: plan.id, operation_id: operation.id, crash_recovery: true, drift: true, partial_failure: true, readonly_authorization: true, aws_connectivity_tested: false }));
} finally { await stop(); }

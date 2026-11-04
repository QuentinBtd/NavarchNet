import assert from "node:assert/strict";

// Matches Store.claim's durable lease. The contract test detects source-policy drift.
export const SMOKE_CLAIM_LEASE_MS = 15_000;
const pollMs = 100;
const progressPolls = 150;

export async function waitForOperation(id, expected, read, { recovering = false, sleep } = {}) {
  // A killed claimant may retain the entire lease before progress can restart.
  // Reserve it only after SIGKILL; ordinary completion retains its original budget.
  // These bound polling/sleep work, not HTTP latency or a hard wall-clock deadline.
  const polls = progressPolls + (recovering ? SMOKE_CLAIM_LEASE_MS / pollMs : 0);
  for (let i = 0; i < polls; i++) {
    const operation = await read();
    if (["succeeded", "partial", "failed"].includes(operation.status)) {
      assert.equal(operation.status, expected);
      return operation;
    }
    await sleep(pollMs);
  }
  throw new Error(`Operation ${id} did not finish`);
}

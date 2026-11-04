import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflow, workflow } from "./workflow-policy.mjs";

test("real workflow is manual, pinned, read-only and uses shared local tasks", () => {
  validateWorkflow(workflow());
});
test("automatic push and PR events fail the local cost guard", () => {
  for (const event of ["push", "pull_request", "pull_request_target", "schedule", "issue_comment"])
    assert.throws(() => validateWorkflow(workflow().replace("on:\n", `on:\n  ${event}:\n`)));
});
test("mutable action revisions fail the local guard", () => {
  assert.throws(() => validateWorkflow(workflow().replace(/@[a-f0-9]{40}/, "@main")));
});
test("write permission and loss of the shared gate fail the guard", () => {
  assert.throws(() => validateWorkflow(workflow().replace("contents: read", "contents: write")));
  assert.throws(() => validateWorkflow(workflow().replace("mise run check", "true")));
});

import { afterEach, expect, it, vi } from "vitest";
import type { Operation } from "./generated";
import { renderOperationReview } from "./operation-review-view";

const operation = (id: string, status = "succeeded"): Operation => ({
  id,
  plan_id: `plan-${id}`,
  scope: "scope",
  status,
  step: 3,
  attempts: 2,
  error: null,
  fault: "none",
});
afterEach(() => document.body.replaceChildren());
function mount(operations: Operation[], selectedOperationId?: string, current = () => true) {
  const onSelect = vi.fn();
  const makeInspect = vi.fn(() => document.createElement("button"));
  const makeDrift = vi.fn(() => document.createElement("button"));
  const node = renderOperationReview(operations, [], {
    selectedOperationId,
    isCurrent: current,
    onSelect,
    makeInspect,
    makeDrift,
  });
  document.body.append(node);
  return { node, onSelect, makeInspect, makeDrift };
}
it("keeps every returned operation selectable with one original contextual detail and no invented plan total", () => {
  const operations = Array.from({ length: 100 }, (_, i) => operation(String(i)));
  const before = structuredClone(operations);
  const { node, makeInspect } = mount(operations, "50");
  expect(node.querySelectorAll("select option")).toHaveLength(100);
  expect(node.querySelectorAll("article")).toHaveLength(1);
  expect(node.querySelector("article")?.dataset.operationId).toBe("50");
  expect(node.textContent).toContain("100 returned operations");
  expect(node.querySelector("h3")?.textContent).toContain("plan total unavailable");
  expect(node.textContent).toContain("not a connectivity measurement");
  expect(node.querySelector("details")?.open).toBe(false);
  expect(JSON.parse(node.querySelector("pre")?.textContent ?? "null")).toEqual(operations[50]);
  expect(makeInspect).toHaveBeenCalledWith(operations[50]);
  expect(operations).toEqual(before);
});
it("exposes no inspection or drift for a missing or duplicate selected identity", () => {
  for (const values of [[operation("different")], [operation("duplicate"), operation("duplicate")]]) {
    const { node, makeInspect, makeDrift } = mount(values, "duplicate");
    expect(node.querySelector("article")).toBeNull();
    expect(makeInspect).not.toHaveBeenCalled();
    expect(makeDrift).not.toHaveBeenCalled();
    expect(node.textContent).toContain("unavailable or ambiguous");
  }
});
it("retains literal inert state, permits drift only for terminal status and retires selection callbacks", () => {
  let current = true;
  const value = operation("<img src=x onerror=alert(1)>", "running");
  value.error = "<script>inert</script>";
  const { node, makeDrift, onSelect } = mount([value, operation("other")], value.id, () => current);
  expect(node.querySelector("img, script")).toBeNull();
  expect(node.textContent).toContain(value.error);
  expect(makeDrift).not.toHaveBeenCalled();
  const select = node.querySelector("select");
  if (!select) throw new Error("Missing operation selection");
  select.value = "other";
  select.dispatchEvent(new Event("change"));
  expect(onSelect).toHaveBeenCalledWith("other");
  current = false;
  select.dispatchEvent(new Event("change"));
  current = true;
  node.remove();
  select.dispatchEvent(new Event("change"));
  expect(onSelect).toHaveBeenCalledTimes(1);
  const empty = mount([]);
  expect(empty.makeInspect).not.toHaveBeenCalled();
});

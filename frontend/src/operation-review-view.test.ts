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

const originalPlan = (id: string): Parameters<typeof renderOperationReview>[1][number] => ({
  id,
  scope: "scope",
  scope_version: 1,
  inventory_revision: 1,
  network_revision: 1,
  digest: `digest-${id}`,
  request: {
    account_id: "account",
    vpc_id: "vpc",
    subnet_ids: ["subnet"],
    network_id: "network",
    allow_application_traffic: false,
  },
  actions: [{ kind: "attachment", target: "vpc", requires: [], postcondition: "simulated available" }],
});
it("reviews only the exact original plan and leaves missing or ambiguous history unavailable", () => {
  const op = { ...operation(" <literal> "), step: 1 },
    plan = originalPlan(op.plan_id),
    other = originalPlan("other");
  const onReviewPlan = vi.fn();
  let current = true;
  const mountReview = (plans: (typeof plan)[]) => {
    const root = renderOperationReview([op], plans, {
      isCurrent: () => current,
      onSelect: () => {},
      makeInspect: () => document.createElement("button"),
      onReviewPlan,
    });
    document.body.append(root);
    return root;
  };
  const root = mountReview([other, plan]),
    review = root.querySelector<HTMLButtonElement>("article button");
  if (!review) throw new Error("Missing original-plan action");
  expect(review.textContent).toBe("Review original plan");
  expect(review.disabled).toBe(false);
  expect(root.querySelector("img,script")).toBeNull();
  review.click();
  expect(onReviewPlan).toHaveBeenCalledExactlyOnceWith(plan);
  current = false;
  review.click();
  current = true;
  review.remove();
  review.click();
  root.append(review);
  root.remove();
  review.click();
  expect(onReviewPlan).toHaveBeenCalledTimes(1);
  for (const values of [[], [plan, { ...plan }]]) {
    const unavailable = mountReview(values),
      blocked = unavailable.querySelector<HTMLButtonElement>("article button");
    if (!blocked) throw new Error("Missing unavailable action");
    expect(blocked.disabled).toBe(true);
    blocked.disabled = false;
    blocked.click();
    expect(onReviewPlan).toHaveBeenCalledTimes(1);
    expect(unavailable.textContent).toContain("Original plan unavailable or ambiguous in returned history");
    expect(unavailable.querySelector("h3")?.textContent).toContain("plan total unavailable");
  }
});

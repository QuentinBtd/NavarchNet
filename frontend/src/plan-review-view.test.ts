import { afterEach, expect, it, vi } from "vitest";
import type { Plan } from "./generated";
import { renderPlanReview } from "./plan-review-view";

function plan(id: string): Plan {
  return {
    id,
    scope: `scope-${id}`,
    scope_version: 1,
    inventory_revision: 2,
    network_revision: 3,
    digest: `immutable-${id}`,
    request: {
      account_id: "account",
      vpc_id: `vpc-${id}`,
      subnet_ids: ["subnet-1", "subnet-2"],
      network_id: "network",
      allow_application_traffic: false,
    },
    actions: [
      {
        kind: "attachment",
        target: `target-${id}`,
        requires: [],
        postcondition: "attachment reported available",
      },
      {
        kind: "return_route",
        target: "literal route",
        requires: [0],
        postcondition: "return route observed",
      },
    ],
  };
}
afterEach(() => {
  document.body.replaceChildren();
});
function mount(plans: Plan[], selectedPlanId?: string, current = () => true) {
  const onSelect = vi.fn();
  const makeApply = vi.fn((value: Plan) => {
    const button = document.createElement("button");
    button.textContent = `Apply ${value.id}`;
    return button;
  });
  const node = renderPlanReview(plans, { selectedPlanId, isCurrent: current, onSelect, makeApply });
  document.body.append(node);
  return { node, onSelect, makeApply };
}
it("keeps the complete returned history compact and renders only the selected immutable plan", () => {
  const plans = Array.from({ length: 100 }, (_, i) => plan(String(i)));
  const before = structuredClone(plans);
  const { node, makeApply } = mount(plans, "50");
  expect(node.querySelectorAll("article")).toHaveLength(1);
  expect(node.querySelectorAll("select option")).toHaveLength(100);
  expect(node.querySelector("article")?.dataset.planId).toBe("50");
  expect(node.querySelectorAll("article ol > li")).toHaveLength(2);
  expect(node.textContent).toContain("Requires steps: 1");
  expect(node.textContent).toContain("return route observed");
  expect(node.textContent).toContain("100 returned plans");
  expect(makeApply).toHaveBeenCalledWith(plans[50]);
  const detail = node.querySelector("details");
  expect(detail?.open).toBe(false);
  expect(JSON.parse(detail?.querySelector("pre")?.textContent ?? "null")).toEqual(plans[50]);
  expect(plans).toEqual(before);
});
it("defaults to the first returned plan without sorting or mutating the response", () => {
  const { node } = mount([plan("new"), plan("old")]);
  expect(node.querySelector("article")?.dataset.planId).toBe("new");
});
it("compares unavailable before evidence with the exact selected plan's proposed targets", () => {
  const plans = [plan("new"), plan("old")];
  const before = structuredClone(plans);
  const { node, makeApply } = mount(plans, "old");
  const comparison = node.querySelector('[aria-label="Plan impact comparison"]');
  expect(comparison).not.toBeNull();
  expect(comparison?.getAttribute("data-plan-id")).toBe("old");
  expect(comparison?.getAttribute("data-plan-digest")).toBe(plans[1].digest);
  expect(comparison?.textContent).toContain("Original route targets are not stored in this plan");
  expect(comparison?.textContent).toContain("Proposed simulation");
  expect(comparison?.textContent).toContain("target-old");
  expect(comparison?.textContent).not.toContain("target-new");
  expect(makeApply).toHaveBeenCalledWith(plans[1]);
  expect(plans).toEqual(before);
});
it("retains every grouped target and literal repeated entries without changing ordered evidence", () => {
  const value = plan("grouped");
  value.actions = [
    { kind: "nat_route", target: "az-one", requires: [], postcondition: "required one" },
    { kind: "nat_route", target: "az-two", requires: [0], postcondition: "required two" },
    { kind: "nat_route", target: "az-two", requires: [0], postcondition: "literal duplicate" },
  ];
  const { node } = mount([value]);
  const group = node.querySelector('[data-action-kind="nat_route"]');
  expect(group?.querySelector("dt")?.textContent).toContain("3");
  expect(group?.querySelector("dd")?.textContent).toBe("az-one, az-two, az-two");
  expect(node.querySelectorAll("ol > li")).toHaveLength(3);
  expect(JSON.parse(node.querySelector("details pre")?.textContent ?? "null")).toEqual(value);
});
it("does not turn unavailable policy metadata into a no-application-access assertion", () => {
  const value = plan("unknown");
  value.request.allow_application_traffic = undefined as unknown as boolean;
  const { node } = mount([value]);
  const comparison = node.querySelector('[aria-label="Plan impact comparison"]');
  expect(comparison?.textContent).toContain("Application-traffic policy unavailable");
  expect(comparison?.textContent).not.toContain("No application-to-application access requested");
});
it("does not silently replace a selected plan missing from the bounded returned history", () => {
  const { node, makeApply } = mount([plan("other")], "missing");
  expect(node.querySelector("article")).toBeNull();
  expect(makeApply).not.toHaveBeenCalled();
  expect(node.textContent).toContain("Choose a returned plan");
});
it("does not expose execution for ambiguous selected identities", () => {
  const { node, makeApply } = mount([plan("duplicate"), plan("duplicate")], "duplicate");
  expect(node.querySelector("article")).toBeNull();
  expect(makeApply).not.toHaveBeenCalled();
});
it("selects locally only while its view is connected and current", () => {
  let current = true;
  const { node, onSelect } = mount([plan("a"), plan("b")], "a", () => current);
  const select = node.querySelector("select");
  if (!select) throw new Error("Missing history selection");
  select.value = "b";
  select.dispatchEvent(new Event("change"));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith("b");
  current = false;
  select.dispatchEvent(new Event("change"));
  current = true;
  node.remove();
  select.dispatchEvent(new Event("change"));
  expect(onSelect).toHaveBeenCalledTimes(1);
});
it("keeps literal plan/provider values inert and handles an empty returned history", () => {
  const p = plan("<img src=x onerror=alert(1)>");
  const { node } = mount([p]);
  expect(node.querySelector("img")).toBeNull();
  expect(node.textContent).toContain(p.request.vpc_id);
  expect(node.textContent).toContain("not tested");
  const empty = mount([]);
  expect(empty.node.querySelector("article")).toBeNull();
  expect(empty.makeApply).not.toHaveBeenCalled();
});

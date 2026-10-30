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

it("shows only the selected immutable request's account and every ordered literal subnet without joining inventory", () => {
  const older = plan("older"),
    other = plan("other");
  older.request.account_id = "account-<img src=x>";
  older.request.subnet_ids = [" subnet-repeated ", "<script>literal</script>", " subnet-repeated ", ""];
  other.request.account_id = "unselected-account";
  other.request.subnet_ids = ["unselected-subnet"];
  const plans = [other, older],
    before = structuredClone(plans);
  const { node, makeApply } = mount(plans, older.id);
  const comparison = node.querySelector('[aria-label="Plan impact comparison"]');
  expect(comparison?.getAttribute("data-plan-id")).toBe(older.id);
  expect(comparison?.getAttribute("data-plan-digest")).toBe(older.digest);
  expect(comparison?.querySelector("[data-request-account]")?.textContent).toBe(older.request.account_id);
  expect(
    [...(comparison?.querySelectorAll("[data-request-subnets] li") ?? [])].map((n) => n.textContent),
  ).toEqual(older.request.subnet_ids);
  expect(comparison?.textContent).not.toContain("unselected-account");
  expect(comparison?.textContent).not.toContain("unselected-subnet");
  expect(comparison?.textContent).toContain("Original route targets are not stored in this plan");
  expect(comparison?.querySelectorAll("img,script,form,input,button,select")).toHaveLength(0);
  expect(makeApply).toHaveBeenCalledWith(older);
  expect(JSON.parse(node.querySelector("details pre")?.textContent ?? "null")).toEqual(older);
  expect(plans).toEqual(before);
});

it("downloads the exact older selected original plan locally even when execution is disabled", async () => {
  const older = plan("older-<img src=x>"),
    plans = [plan("newest"), older],
    before = structuredClone(plans);
  const create = vi.fn((_blob: Blob) => "blob:original-plan"),
    revoke = vi.fn(),
    fetch = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  vi.stubGlobal("fetch", fetch);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.download).toBe("navarchnet-plan.json");
    expect(this.href).toBe("blob:original-plan");
    expect(this.isConnected).toBe(true);
  });
  try {
    const { node, makeApply, onSelect } = mount(plans, older.id);
    const apply = [...node.querySelectorAll("button")].find((n) => n.textContent?.startsWith("Apply"));
    if (!apply) throw new Error("Missing apply control");
    apply.disabled = true;
    const download = node.querySelector<HTMLButtonElement>("[data-plan-export]");
    expect(download).not.toBeNull();
    expect(download?.disabled).toBe(false);
    download?.click();
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    const blob = create.mock.calls[0]?.[0];
    expect(blob?.type).toBe("application/json");
    if (!blob) throw new Error("Missing original JSON blob");
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(content).toBe(node.querySelector("details pre")?.textContent);
    expect(JSON.parse(content)).toEqual(older);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:original-plan"));
    expect(node.querySelectorAll("a[download]")).toHaveLength(0);
    expect(node.querySelectorAll("img,script")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(makeApply).toHaveBeenCalledExactlyOnceWith(older);
    expect(plans).toEqual(before);
  } finally {
    click.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("does not export missing, ambiguous, retired, detached, removed or disabled plan controls", () => {
  const create = vi.fn(),
    revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  try {
    expect(mount([plan("other")], "missing").node.querySelector("[data-plan-export]")).toBeNull();
    expect(
      mount([plan("duplicate"), plan("duplicate")], "duplicate").node.querySelector("[data-plan-export]"),
    ).toBeNull();
    let current = false;
    const { node } = mount([plan("one")], "one", () => current);
    const download = node.querySelector<HTMLButtonElement>("[data-plan-export]");
    expect(download).not.toBeNull();
    download?.dispatchEvent(new MouseEvent("click"));
    current = true;
    node.remove();
    download?.dispatchEvent(new MouseEvent("click"));
    document.body.append(node);
    download?.remove();
    download?.dispatchEvent(new MouseEvent("click"));
    if (!download) throw new Error("Missing plan download control");
    node.append(download);
    download.disabled = true;
    download.dispatchEvent(new MouseEvent("click"));
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reviews only the exact uniquely linked original returned operation as a local read", () => {
  const older = plan("older"),
    other = plan("other");
  const linked = {
    id: "recorded-older",
    plan_id: older.id,
    scope: older.scope,
    status: "partial",
    step: 1,
    attempts: 2,
    error: "literal <img src=x> failure",
    fault: "none" as const,
  };
  const operations = [{ ...linked, id: "other-operation", plan_id: other.id, scope: other.scope }, linked];
  const before = structuredClone(operations),
    onReviewOperation = vi.fn(),
    onSelect = vi.fn();
  const node = renderPlanReview([other, older], {
    selectedPlanId: older.id,
    operations,
    isCurrent: () => true,
    onSelect,
    onReviewOperation,
    makeApply: () => {
      const button = document.createElement("button");
      button.disabled = true;
      return button;
    },
  });
  document.body.append(node);
  const action = node.querySelector<HTMLButtonElement>("[data-plan-operation]");
  expect(action).not.toBeNull();
  expect(action?.disabled).toBe(false);
  action?.click();
  expect(onReviewOperation).toHaveBeenCalledExactlyOnceWith(older, linked);
  expect(onReviewOperation.mock.calls[0]?.[0]).toBe(older);
  expect(onReviewOperation.mock.calls[0]?.[1]).toBe(linked);
  expect(onSelect).not.toHaveBeenCalled();
  expect(operations).toEqual(before);
  expect(node.querySelector("img")).toBeNull();
});

it("refuses ambiguous or incomplete operation identity context and retired recorded-operation controls", () => {
  const selected = plan("selected");
  const linked = {
    id: "recorded",
    plan_id: selected.id,
    scope: selected.scope,
    status: "queued",
    step: 0,
    attempts: 0,
    error: null,
    fault: "none" as const,
  };
  const onReviewOperation = vi.fn();
  let current = true;
  const render = (operations: (typeof linked)[] | undefined) => {
    const node = renderPlanReview([selected], {
      operations,
      isCurrent: () => current,
      onSelect: () => {},
      onReviewOperation,
      makeApply: () => document.createElement("button"),
    });
    document.body.append(node);
    const action = node.querySelector<HTMLButtonElement>("[data-plan-operation]");
    expect(action).not.toBeNull();
    return { node, action };
  };
  const unrelated = Array.from({ length: 80 }, (_, i) => ({
    ...linked,
    id: `other-${i}`,
    plan_id: `other-${i}`,
  }));
  const sparse = [linked, ...unrelated];
  sparse.length = 82;
  const malformed = [linked, ...unrelated];
  malformed[80] = { ...linked, id: undefined as unknown as string };
  const inherited = [linked, ...unrelated];
  inherited.length = 82;
  Object.setPrototypeOf(
    inherited,
    Object.assign(Object.create(Array.prototype), {
      81: { ...linked, id: "inherited", plan_id: "unrelated" },
    }),
  );
  for (const operations of [
    undefined,
    [],
    [linked, { ...linked }],
    [linked, { ...linked, id: "second-for-same-plan" }],
    [linked, { ...linked, plan_id: "another-plan" }],
    [{ ...linked, scope: "wrong-scope" }],
    [{ ...linked, plan_id: "wrong-plan" }],
    sparse,
    inherited,
    malformed,
  ]) {
    const { node, action } = render(operations);
    expect(action?.disabled).toBe(true);
    expect(node.textContent).toContain("unavailable or ambiguous in returned history");
    action?.dispatchEvent(new MouseEvent("click"));
    expect(onReviewOperation).not.toHaveBeenCalled();
    node.remove();
  }
  const { node, action } = render([linked]);
  current = false;
  action?.click();
  current = true;
  node.remove();
  action?.click();
  document.body.append(node);
  action?.remove();
  action?.click();
  if (!action) throw new Error("Missing recorded-operation control");
  node.append(action);
  action.disabled = true;
  action.dispatchEvent(new MouseEvent("click"));
  expect(onReviewOperation).not.toHaveBeenCalled();
});

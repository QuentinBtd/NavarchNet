import { afterEach, expect, it, vi } from "vitest";
import type { Plan } from "./generated";
import { renderPlanActionDetail } from "./plan-action-detail";
import { actionLabels, renderPlanReview } from "./plan-review-view";

function plan(id: string): Plan {
  return {
    id,
    digest: `digest-${id}`,
    scope: `scope-${id}`,
    scope_version: 0,
    inventory_revision: 1,
    network_revision: 1,
    request: {
      account_id: "account",
      vpc_id: "vpc",
      subnet_ids: ["subnet"],
      network_id: "network",
      allow_application_traffic: false,
    },
    actions: [
      { kind: "attachment", target: `attachment-${id}`, requires: [], postcondition: "available required" },
      {
        kind: "return_route",
        target: `route-${id}`,
        requires: [0],
        postcondition: "route observed required",
      },
    ],
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("reviews the selected original action and its dependencies locally outside technical evidence", () => {
  const plans = [plan("new"), plan("old")];
  const before = structuredClone(plans);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const root = renderPlanReview(plans, {
    selectedPlanId: "old",
    isCurrent: () => true,
    onSelect: vi.fn(),
    makeApply: () => {
      const button = document.createElement("button");
      button.textContent = "Apply original";
      button.disabled = true;
      return button;
    },
  });
  document.body.append(root);
  const detail = root.querySelector<HTMLElement>('[aria-label="Requested action detail"]');
  expect(detail).not.toBeNull();
  if (!detail) throw new Error("Missing requested action detail");
  expect(detail.closest("details")).toBeNull();
  expect(detail.dataset.planId).toBe("old");
  expect(detail.dataset.planDigest).toBe("digest-old");
  expect(detail.dataset.actionIndex).toBe("0");
  expect(detail.querySelector("[data-proposed-target]")?.textContent).toBe("attachment-old");
  expect(detail.querySelector("[data-required-postcondition]")?.textContent).toBe("available required");
  expect(detail.textContent).toContain("not evidence of execution");
  const button = (label: string) =>
    [...detail.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(button("Previous proposed action")?.disabled).toBe(true);
  button("Next proposed action")?.click();
  expect(detail.dataset.actionIndex).toBe("1");
  expect(detail.querySelector("[data-proposed-target]")?.textContent).toBe("route-old");
  expect(detail.querySelector("[data-required-postcondition]")?.textContent).toBe("route observed required");
  expect(button("Next proposed action")?.disabled).toBe(true);
  button("Inspect requested step 1")?.click();
  expect(detail.dataset.actionIndex).toBe("0");
  expect(root.querySelector("button")?.textContent).toBe("Apply original");
  expect(root.querySelectorAll("select option")).toHaveLength(2);
  expect(root.querySelector("details")?.open).toBe(false);
  expect(JSON.parse(root.querySelector("details pre")?.textContent ?? "null")).toEqual(before[1]);
  expect(plans).toEqual(before);
  expect(fetcher).not.toHaveBeenCalled();
});

it("captures exact requested scalars and rejects complete malformed or excessive action context atomically", () => {
  const literal = plan("literal");
  const last = literal.actions[1];
  if (!last) throw new Error("Missing fixture row");
  last.kind = "constructor" as typeof last.kind;
  last.target = last.postcondition = "";
  last.requires = [0, 0];
  const root = renderPlanActionDetail(literal, actionLabels, () => true);
  document.body.append(root);
  last.target = "later";
  last.postcondition = "later";
  last.requires.length = 0;
  literal.id = literal.digest = "later";
  const next = [...root.querySelectorAll("button")].find(
    (node) => node.textContent === "Next proposed action",
  );
  next?.click();
  expect(root.dataset.planId).toBe("literal");
  expect(root.dataset.planDigest).toBe("digest-literal");
  expect(root.querySelector("[data-proposed-kind]")?.textContent).toBe("constructor");
  expect(root.querySelector("[data-proposed-target]")?.textContent).toBe('"" (empty string)');
  expect(root.querySelector("[data-required-postcondition]")?.textContent).toBe('"" (empty string)');
  expect(
    [...root.querySelectorAll<HTMLElement>("[data-required-index]")].map(
      (node) => node.dataset.requiredIndex,
    ),
  ).toEqual(["0", "0"]);
  expect(root.querySelectorAll("img,script")).toHaveLength(0);
  const bad = (change: (value: Plan) => void) => {
    const value = plan("invalid");
    change(value);
    return value;
  };
  const cases: unknown[] = [
    null,
    {},
    Object.create(plan("inherited")),
    bad((value) => {
      value.actions.length = 1001;
    }),
    bad((value) => {
      value.actions.length = 3;
    }),
    bad((value) => {
      Object.setPrototypeOf(
        value.actions,
        Object.create(Array.prototype, { 2: { value: value.actions[0] } }),
      );
      value.actions.length = 3;
    }),
    bad((value) => {
      value.actions[1] = Object.create(value.actions[0]);
    }),
    bad((value) => {
      Reflect.deleteProperty(value.actions[1] ?? {}, "postcondition");
    }),
    bad((value) => {
      Reflect.set(value, "actions", null);
    }),
    bad((value) => {
      Reflect.set(value.actions[1] ?? {}, "target", "x".repeat(16385));
    }),
    bad((value) => {
      Reflect.set(value.actions[1] ?? {}, "requires", new Array(2));
    }),
    bad((value) => {
      const requires = new Array(1);
      Object.setPrototypeOf(requires, Object.create(Array.prototype, { 0: { value: 0 } }));
      Reflect.set(value.actions[1] ?? {}, "requires", requires);
    }),
    bad((value) => {
      const first = value.actions[0];
      if (!first) throw new Error("Missing fixture row");
      value.actions = Array.from({ length: 11 }, () => ({ ...first, requires: Array(1000).fill(0) }));
    }),
    ...[-1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map((dependency) =>
      bad((value) => {
        Reflect.set(value.actions[1] ?? {}, "requires", [dependency]);
      }),
    ),
  ];
  for (const value of cases) {
    const invalid = renderPlanActionDetail(value as Plan, actionLabels, () => true);
    expect(invalid.textContent).toContain("Requested actions unavailable");
    expect(invalid.querySelector("[data-proposed-target]")).toBeNull();
    expect(invalid.querySelector("button")).toBeNull();
    expect(invalid.dataset.actionIndex).toBeUndefined();
  }
  const empty = plan("empty");
  empty.actions = [];
  expect(renderPlanActionDetail(empty, actionLabels, () => true).textContent).toContain(
    "No requested actions returned",
  );
  const boundary = plan("bounded");
  const first = boundary.actions[0];
  if (!first) throw new Error("Missing fixture row");
  boundary.actions = Array.from({ length: 1000 }, (_, index) => ({
    ...first,
    target: String(index),
    requires: index === 0 ? [999] : [],
  }));
  const bounded = renderPlanActionDetail(boundary, actionLabels, () => true);
  document.body.append(bounded);
  bounded.querySelector<HTMLButtonElement>("[data-required-index]")?.click();
  expect(bounded.dataset.actionIndex).toBe("999");
  expect(bounded.querySelectorAll("[data-proposed-target]")).toHaveLength(1);
  expect(bounded.querySelector("[data-proposed-target]")?.textContent).toBe("999");
});

it("fences local detail controls across disabled, removed, moved, retired draws and boundary forgery", () => {
  const original = plan("controls");
  const before = structuredClone(original);
  let live = true;
  const root = renderPlanReview([original], {
    isCurrent: () => live,
    onSelect: vi.fn(),
    makeApply: () => document.createElement("button"),
  });
  document.body.append(root);
  const detail = root.querySelector<HTMLElement>('[aria-label="Requested action detail"]');
  const card = detail?.parentElement;
  const next = [...(detail?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent === "Next proposed action",
  );
  const previous = [...(detail?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent === "Previous proposed action",
  );
  if (!detail || !card || !next || !previous) throw new Error("Missing local review controls");
  const dispatch = (control: HTMLButtonElement) =>
    control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  previous.disabled = false;
  dispatch(previous);
  previous.disabled = true;
  next.click();
  expect(detail.dataset.actionIndex).toBe("1");
  next.disabled = false;
  dispatch(next);
  next.disabled = true;
  previous.click();
  expect(detail.dataset.actionIndex).toBe("0");
  next.disabled = true;
  dispatch(next);
  next.disabled = false;
  expect(detail.dataset.actionIndex).toBe("0");
  next.remove();
  dispatch(next);
  detail.append(next);
  expect(detail.dataset.actionIndex).toBe("0");
  document.body.append(next);
  dispatch(next);
  detail.append(next);
  expect(detail.dataset.actionIndex).toBe("0");
  document.body.append(detail);
  dispatch(next);
  card.append(detail);
  expect(detail.dataset.actionIndex).toBe("0");
  document.body.append(card);
  dispatch(next);
  root.append(card);
  expect(detail.dataset.actionIndex).toBe("0");
  root.remove();
  dispatch(next);
  document.body.append(root);
  expect(detail.dataset.actionIndex).toBe("0");
  live = false;
  dispatch(next);
  live = true;
  expect(detail.dataset.actionIndex).toBe("0");
  next.click();
  const retired = detail.querySelector<HTMLButtonElement>("[data-required-index]");
  const display = detail.querySelector("div");
  if (!retired || !display) throw new Error("Missing dependency detail");
  retired.click();
  next.click();
  display.append(retired);
  dispatch(retired);
  expect(detail.dataset.actionIndex).toBe("1");
  expect(original).toEqual(before);
});

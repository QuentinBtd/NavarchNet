import { afterEach, expect, it, vi } from "vitest";
import type { Operation, Plan, Snapshot } from "./generated";
import { renderOperationReview } from "./operation-review-view";
import { renderOperationStepHistory } from "./operation-step-history";

const operation = (): Operation => ({
  id: "operation",
  plan_id: "original",
  scope: "literal-scope",
  status: "partial",
  step: 1,
  attempts: 1,
  error: "Reported conflict",
  fault: "none",
});
const plan = (): Plan => ({
  id: "original",
  scope: "literal-scope",
  scope_version: 1,
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
    {
      kind: "nat_route",
      target: "literal-target",
      requires: [],
      postcondition: "Original requested postcondition",
    },
  ],
  digest: "original-digest",
});
const events = () =>
  Array.from({ length: 25 }, (_, index) => ({
    step: 0,
    fence: index + 1,
    outcome: index ? "unknown-outcome" : "postcondition_verified_in_simulator",
    at: "opaque-reported-time",
  }));
const button = (root: HTMLElement, label: string) => {
  const value = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  if (!value) throw new Error(`Missing ${label}`);
  return value;
};
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.doUnmock("./operation-review-view");
});

it("shows captured original requested action separately from reported outcomes without changing event order or original JSON", () => {
  const op = operation(),
    original = plan(),
    raw = events();
  const before = structuredClone({ op, original, raw });
  const root = renderOperationStepHistory(raw, op.id, () => true, {
    operation: op,
    operations: [op],
    plans: [original],
  });
  document.body.append(root);
  expect(root.querySelectorAll("[data-requested-action]")).toHaveLength(20);
  expect(root.textContent).toContain("Configure NAT route");
  expect(root.textContent).toContain("Requested action from original plan");
  expect(root.textContent).toContain("not evidence that this action executed");
  for (const item of root.querySelectorAll("[data-requested-action]")) {
    expect((item as HTMLElement).dataset.planId).toBe(original.id);
    expect((item as HTMLElement).dataset.actionKind).toBe("nat_route");
    expect(item.textContent).toContain("literal-target");
    expect(item.textContent).toContain("Configure NAT route · literal-target");
  }
  expect({ op, original, raw }).toEqual(before);
  original.actions[0].target = "later-mutated-target";
  button(root, "Show more returned step events").click();
  expect(root.querySelectorAll("li")).toHaveLength(25);
  expect(root.querySelectorAll("[data-requested-action]")).toHaveLength(25);
  expect(root.textContent).not.toContain("later-mutated-target");
  expect([...root.querySelectorAll<HTMLElement>("li")].map((row) => row.dataset.eventIndex)).toEqual(
    raw.map((_, i) => String(i)),
  );
  expect(raw).toEqual(before.raw);
});

it("keeps an ID-only cross-scope plan unavailable for original-plan navigation and completion totals", () => {
  const op = operation(),
    wrong = { ...plan(), scope: "different-literal-scope" };
  const review = vi.fn();
  const root = renderOperationReview([op], [wrong], {
    isCurrent: () => true,
    onSelect: vi.fn(),
    makeInspect: () => document.createElement("button"),
    onReviewPlan: review,
  });
  document.body.append(root);
  expect(button(root, "Review original plan").disabled).toBe(true);
  expect(root.textContent).toContain("plan total unavailable");
  button(root, "Review original plan").dispatchEvent(new MouseEvent("click"));
  expect(review).not.toHaveBeenCalled();
});

it("the real parent rejects forged or corrupted original-plan callbacks before navigating", async () => {
  vi.resetModules();
  let captured:
    | { operations: Operation[]; plans: Plan[]; options: Parameters<typeof renderOperationReview>[2] }
    | undefined;
  vi.doMock("./operation-review-view", async () => {
    const real = await vi.importActual<typeof import("./operation-review-view")>("./operation-review-view");
    return {
      ...real,
      renderOperationReview: (
        operations: Operation[],
        plans: Plan[],
        options: Parameters<typeof renderOperationReview>[2],
      ) => {
        captured = { operations, plans, options };
        return real.renderOperationReview(operations, plans, options);
      },
    };
  });
  const source: Snapshot = {
    accounts: [],
    inventory: [],
    networks: [],
    plans: [plan(), { ...plan(), id: "unrelated" }],
    operations: [operation()],
    mode: "demo",
    role: "read_only",
    aws_accounts: [],
    aws_read_only_enabled: false,
    aws_regions: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/snapshot") throw new Error(`Unexpected request ${input}`);
      return new Response(JSON.stringify(source));
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/operations");
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  const login = document.querySelector("#login");
  if (!token || !login) throw new Error("Missing real login controls");
  token.value = "fixture-reader";
  login.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(captured).toBeDefined());
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#operations")?.hidden).toBe(false));
  if (!captured) throw new Error("Missing real parent options");
  const { operations, plans, options } = captured;
  const calls = vi.mocked(fetch).mock.calls.length;
  options.onReviewPlan?.(plans[1]);
  expect(window.location.hash).toBe("#/operations");
  plans[0].scope = "changed-scope";
  options.onReviewPlan?.(plans[0]);
  expect(window.location.hash).toBe("#/operations");
  plans[0].scope = operations[0].scope;
  plans.push({ ...plans[0] });
  options.onReviewPlan?.(plans[0]);
  expect(window.location.hash).toBe("#/operations");
  plans.pop();
  const original = plans[0];
  plans[0] = { ...original };
  options.onReviewPlan?.(plans[0]);
  expect(window.location.hash).toBe("#/operations");
  plans[0] = original;
  options.onReviewPlan?.(plans[0]);
  await vi.waitFor(() => expect(window.location.hash).toBe("#/plans"));
  expect(document.querySelector<HTMLSelectElement>("#plan-selection")?.value).toBe("original");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});

it("keeps all original events readable while unavailable or malformed declared-action context stays atomic and inert", () => {
  type Context = NonNullable<Parameters<typeof renderOperationStepHistory>[3]>;
  const fresh = (): Context => {
    const op = operation();
    return { operation: op, operations: [op], plans: [plan()] };
  };
  const mutations: ((context: Context) => void)[] = [
    (c) => {
      c.plans = [];
    },
    (c) => {
      c.plans[0].scope = "other";
    },
    (c) => {
      c.plans.push({ ...c.plans[0] });
    },
    (c) => {
      c.operations.push({ ...c.operation });
    },
    (c) => {
      c.operation = { ...c.operation };
    },
    (c) => {
      c.plans.length = 22;
    },
    (c) => {
      c.operations.length = 22;
    },
    (c) => {
      c.plans.push(null as unknown as Plan);
    },
    (c) => {
      c.operations.push(null as unknown as Operation);
    },
    (c) => {
      c.plans[0].actions.length = 22;
    },
    (c) => {
      c.plans[0].actions.push(null as unknown as Plan["actions"][number]);
    },
    (c) => {
      c.plans[0].actions[0].kind = "__proto__" as Plan["actions"][number]["kind"];
    },
    (c) => {
      c.plans[0] = Object.assign(Object.create({ scope: "literal-scope" }), { ...c.plans[0] });
      delete (c.plans[0] as Partial<Plan>).scope;
    },
    (c) => {
      const rows = [...c.plans];
      c.plans = Array(1);
      Object.setPrototypeOf(c.plans, Object.assign(Object.create(Array.prototype), { 0: rows[0] }));
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No declared-context requests permitted");
    }),
  );
  for (const mutate of mutations) {
    const context = fresh(),
      raw = events();
    mutate(context);
    const root = renderOperationStepHistory(raw, "operation", () => true, context);
    document.body.append(root);
    expect(root.querySelectorAll("[data-requested-action]")).toHaveLength(0);
    expect(root.querySelectorAll("li")).toHaveLength(20);
    expect(root.textContent).toContain("Original requested action unavailable");
    button(root, "Show more returned step events").click();
    expect(root.querySelectorAll("li")).toHaveLength(25);
    expect(root.querySelectorAll("[data-requested-action]")).toHaveLength(0);
    expect(raw).toEqual(events());
    root.remove();
  }
  const context = fresh();
  context.plans[0].actions[0].target = "<img src=x onerror=alert(1)>";
  const raw = events();
  raw[0].step = 99;
  const root = renderOperationStepHistory(raw, "operation", () => true, context);
  document.body.append(root);
  expect(root.querySelector("img,script")).toBeNull();
  expect(root.querySelector("li")?.textContent).toContain("Original requested action unavailable");
  expect(root.querySelectorAll("[data-requested-action]")).toHaveLength(19);
  expect(root.textContent).toContain(context.plans[0].actions[0].target);
  expect(fetch).not.toHaveBeenCalled();
});

import { afterEach, expect, it, vi } from "vitest";
import type { Plan, Snapshot } from "./generated";
import { renderPlanReview } from "./plan-review-view";

const plan = (): Plan => ({
  id: "original",
  scope: "original-scope",
  scope_version: 7,
  inventory_revision: 1,
  network_revision: 3,
  request: {
    account_id: "account",
    vpc_id: "vpc",
    network_id: "network",
    subnet_ids: ["subnet"],
    allow_application_traffic: false,
  },
  actions: [
    { kind: "attachment", target: "original-target", requires: [], postcondition: "reported available" },
  ],
  digest: "original-digest",
});
const state = (): Snapshot => ({
  accounts: [{ id: "account", name: "Application", provider: "fake", revision: 1, role_arn: "fake:role" }],
  inventory: [
    {
      account_id: "other",
      vpc_id: "vpc",
      region: "eu-west-1",
      cidr: "10.1.0.0/16",
      revision: 99,
      subnets: [],
    },
    {
      account_id: "account",
      vpc_id: "vpc",
      region: "eu-west-1",
      cidr: "10.0.0.0/16",
      revision: 2,
      subnets: [{ id: "subnet", az_id: "az", route_table: "table", default_route_managed: false }],
    },
  ],
  networks: ["other-network", "network"].map((id) => ({
    id,
    name: `Declared ${id}`,
    region: "eu-west-1",
    revision: id === "network" ? 3 : 99,
    egress_cidr: "10.250.0.0/16",
    az_ids: ["az"],
    public_ips: [],
    application_cidrs: [],
    managed_nat: true,
  })),
  plans: [plan()],
  operations: [],
  mode: "demo",
  role: "read_only",
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
function mount(data: Snapshot, currentSnapshot = data) {
  const root = renderPlanReview(data.plans, {
    selectedPlanId: "original",
    isCurrent: () => true,
    onSelect: vi.fn(),
    currentSnapshot,
    makeApply: () => {
      const b = document.createElement("button");
      b.disabled = true;
      return b;
    },
  });
  document.body.append(root);
  return root;
}
const comparison = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[aria-label="Plan revision comparison"]');
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("compares exact composite-scope returned revisions without changing original evidence or granting apply approval", () => {
  const data = state(),
    before = structuredClone(data);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected revision query");
    }),
  );
  const root = mount(data),
    view = comparison(root);
  expect(view).not.toBeNull();
  expect(view?.dataset.revisionComparison).toBe("different");
  expect(view?.textContent).toContain("Plan 1 · returned snapshot 2");
  expect(view?.textContent).toContain("Plan 3 · returned snapshot 3");
  expect(view?.textContent).not.toContain("99");
  expect(view?.textContent).toContain("server still validates apply");
  expect(view?.textContent).toContain("Current scope version is not returned");
  expect(root.querySelector("pre")?.textContent).toBe(JSON.stringify(data.plans[0], null, 2));
  expect(data).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
  data.inventory[1].revision = 1;
  const equal = comparison(mount(data));
  expect(equal?.dataset.revisionComparison).toBe("equal");
  expect(equal?.textContent).toContain("not apply approval");
});

it("keeps missing, ambiguous, malformed, sparse and mismatched original context unavailable without a plausible revision prefix", () => {
  const cases = Array.from({ length: 8 }, () => state());
  cases[0].inventory = cases[0].inventory.filter((i) => i.account_id !== "account");
  cases[1].inventory.push({ ...cases[1].inventory[1] });
  cases[2].networks.push({ ...cases[2].networks[1] });
  cases[3].networks[1].revision = Number.MAX_SAFE_INTEGER + 1;
  cases[4].inventory.push(
    ...Array.from({ length: 80 }, (_, i) => ({ ...cases[4].inventory[0], vpc_id: `vpc-${i}` })),
  );
  delete cases[4].inventory[81];
  cases[5].networks = Array(2) as Snapshot["networks"];
  Object.setPrototypeOf(
    cases[5].networks,
    Object.assign(Object.create(Array.prototype), { 0: state().networks[1] }),
  );
  cases[6].plans[0].inventory_revision = -1;
  cases[7].networks[1].id = "unknown";
  for (const data of cases) {
    const view = comparison(mount(data));
    expect(view).not.toBeNull();
    expect(view?.dataset.revisionComparison).toBe("unavailable");
    expect(view?.textContent).toContain("unavailable or ambiguous");
    expect(view?.querySelector("dl")).toBeNull();
  }
  const original = state(),
    clone = structuredClone(original);
  expect(comparison(mount(original, clone))?.dataset.revisionComparison).toBe("unavailable");
});

it("main refreshes revision context for the same selected original plan and removes old context on logout", async () => {
  vi.resetModules();
  const data = state(),
    original = structuredClone(data.plans[0]);
  data.inventory[1].revision = 1;
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/plans");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/snapshot") throw new Error(`Unexpected revision request ${input}`);
      return new Response(JSON.stringify(data));
    }),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-reader";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("original"),
  );
  expect(comparison()).not.toBeNull();
  expect(comparison()?.dataset.revisionComparison).toBe("equal");
  const old = comparison(),
    calls = vi.mocked(fetch).mock.calls.length;
  data.inventory[1].revision = 4;
  node("#refresh").click();
  await vi.waitFor(() => expect(comparison()?.dataset.revisionComparison).toBe("different"));
  expect(comparison()).not.toBe(old);
  expect(old?.isConnected).toBe(false);
  expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("original");
  expect(document.querySelector("#plan-list pre")?.textContent).toBe(JSON.stringify(original, null, 2));
  expect(document.querySelector<HTMLButtonElement>("#plan-list button[data-write]")?.disabled).toBe(true);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls + 1);
  node("#logout").click();
  expect(comparison()).toBeNull();
  expect(data.plans[0]).toEqual(original);
});

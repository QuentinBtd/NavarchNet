import { afterEach, expect, it, vi } from "vitest";
import type { Plan, Snapshot } from "./generated";
import { configurationForPlan } from "./network-workspace";
import { renderPlanReview } from "./plan-review-view";

const plan = (id: string, networkId = "net"): Plan => ({
  id,
  scope: "scope",
  scope_version: 1,
  inventory_revision: 1,
  network_revision: 1,
  request: {
    account_id: "app",
    vpc_id: "vpc",
    network_id: networkId,
    subnet_ids: ["subnet-one", "subnet-two"],
    allow_application_traffic: false,
  },
  actions: [{ kind: "attachment", target: id, requires: [], postcondition: "reported available" }],
  digest: `original-${id}`,
});
const state = (): Snapshot => ({
  accounts: [{ id: "app", name: "Application", provider: "fake", revision: 1, role_arn: "fake:role" }],
  networks: ["net", "different"].map((id) => ({
    id,
    name: `Declared ${id}`,
    region: "eu-west-1",
    revision: 1,
    egress_cidr: "10.250.0.0/16",
    az_ids: ["az-one"],
    public_ips: [],
    application_cidrs: [],
    managed_nat: true,
  })),
  inventory: [
    {
      account_id: "app",
      vpc_id: "vpc",
      region: "eu-west-1",
      cidr: "10.0.0.0/16",
      revision: 1,
      subnets: [{ id: "subnet-one", az_id: "az-one", route_table: "table", default_route_managed: false }],
    },
  ],
  plans: [plan("newer"), plan("older"), plan("different-plan", "different")],
  operations: [],
  mode: "demo",
  role: "read_only",
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const seed = () => {
  const s = state();
  s.role = "admin";
  s.inventory[0].subnets.push({ ...s.inventory[0].subnets[0], id: "subnet-two" });
  s.plans[1].request.subnet_ids = ["subnet-two"];
  return s;
};
const prepare = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Configure another plan from original request",
  );
it("prepares the exact original one-subnet request only as an explicit local admin action without changing the immutable plan", () => {
  const s = seed(),
    p = s.plans[1],
    before = structuredClone(s),
    onReconfigure = vi.fn();
  const root = renderPlanReview(s.plans, {
    selectedPlanId: p.id,
    isCurrent: () => true,
    onSelect: vi.fn(),
    makeApply: () => document.createElement("button"),
    workspaceSnapshot: s,
    canReconfigure: true,
    onReconfigure,
  });
  document.body.append(root);
  const control = prepare(root);
  expect(control).toBeDefined();
  if (!control) throw new Error("Missing original request configuration");
  expect(control.disabled).toBe(false);
  control.click();
  expect(onReconfigure).toHaveBeenCalledExactlyOnceWith(p);
  expect(root.textContent).toContain("Generate a new immutable plan explicitly");
  expect(s).toEqual(before);
});

it("refuses unrepresentable requests and revalidates permission, original request and retained controls", () => {
  const mutations: ((s: Snapshot) => void)[] = [
    (s) => {
      s.plans[1].request.subnet_ids = [];
    },
    (s) => {
      s.plans[1].request.subnet_ids = ["missing"];
    },
    (s) => {
      s.plans[1].request.subnet_ids = ["subnet-two", "subnet-two"];
    },
    (s) => {
      s.plans[1].request.allow_application_traffic = true;
    },
    (s) => {
      s.inventory[0].subnets.push({ ...s.inventory[0].subnets[1] });
    },
    (s) => {
      s.inventory.push({ ...s.inventory[0], account_id: "other" });
      s.accounts.push({ ...s.accounts[0], id: "other" });
    },
    (s) => {
      s.plans[1].request.subnet_ids.length = 80;
    },
    (s) => {
      s.plans.push({ ...s.plans[1] });
    },
    (s) => {
      s.inventory[0].subnets.length = 80;
    },
  ];
  for (const mutate of mutations) {
    const s = seed(),
      p = s.plans[1];
    mutate(s);
    expect(configurationForPlan(s, p)).toBeUndefined();
  }
  const s = seed(),
    p = s.plans[1],
    calls = vi.fn();
  let admin = true,
    current = true;
  const root = renderPlanReview(s.plans, {
    selectedPlanId: p.id,
    isCurrent: () => current,
    onSelect: vi.fn(),
    makeApply: () => document.createElement("button"),
    workspaceSnapshot: s,
    get canReconfigure() {
      return admin;
    },
    onReconfigure: calls,
  });
  document.body.append(root);
  const control = prepare(root);
  if (!control) throw new Error("Missing prepare");
  admin = false;
  control.click();
  admin = true;
  control.disabled = true;
  control.dispatchEvent(new MouseEvent("click"));
  control.disabled = false;
  const ids = p.request.subnet_ids;
  p.request.subnet_ids = ["subnet-one"];
  control.click();
  p.request.subnet_ids = ids;
  const originalId = p.id;
  p.id = "changed-plan-id";
  control.click();
  p.id = originalId;
  current = false;
  control.click();
  current = true;
  control.remove();
  control.click();
  root.append(control);
  root.remove();
  control.click();
  expect(calls).not.toHaveBeenCalled();
});

it("the real parent refuses forged requests, replaced subnets, reader roles and ambiguous options before preparing the original selection", async () => {
  vi.resetModules();
  let captured: { plans: Plan[]; options: Parameters<typeof renderPlanReview>[1] } | undefined;
  vi.doMock("./plan-review-view", async () => {
    const real = await vi.importActual<typeof import("./plan-review-view")>("./plan-review-view");
    return {
      ...real,
      renderPlanReview: (plans: Plan[], options: Parameters<typeof renderPlanReview>[1]) => {
        captured = { plans, options };
        return real.renderPlanReview(plans, options);
      },
    };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/snapshot") throw new Error(`Unexpected request ${input}`);
      return new Response(JSON.stringify(seed()));
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/plans");
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token"),
    login = document.querySelector("#login");
  if (!token || !login) throw new Error("Missing login");
  token.value = "fixture-admin";
  login.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#plans")?.hidden).toBe(false));
  const select = document.querySelector<HTMLSelectElement>("#plan-selection");
  if (!select) throw new Error("Missing plans");
  select.value = "older";
  select.dispatchEvent(new Event("change"));
  if (!captured) throw new Error("Missing parent");
  const { plans, options } = captured,
    s = options.workspaceSnapshot as Snapshot;
  if (!s) throw new Error("Missing source");
  const p = plans[1],
    calls = vi.mocked(fetch).mock.calls.length;
  options.onReconfigure?.({ ...p });
  expect(window.location.hash).toBe("#/plans");
  const ids = p.request.subnet_ids;
  p.request.subnet_ids = ["subnet-one"];
  options.onReconfigure?.(p);
  expect(window.location.hash).toBe("#/plans");
  p.request.subnet_ids = ids;
  const subnet = s.inventory[0].subnets[1];
  s.inventory[0].subnets[1] = { ...subnet };
  options.onReconfigure?.(p);
  expect(window.location.hash).toBe("#/plans");
  s.inventory[0].subnets[1] = subnet;
  s.role = "read_only";
  options.onReconfigure?.(p);
  expect(window.location.hash).toBe("#/plans");
  s.role = "admin";
  const originalId = p.id;
  p.id = "changed-plan-id";
  options.onReconfigure?.(p);
  expect(window.location.hash).toBe("#/plans");
  p.id = originalId;
  const vpc = document.querySelector<HTMLSelectElement>("#vpc");
  if (!vpc) throw new Error("Missing VPC");
  const duplicate = document.createElement("option");
  duplicate.value = s.inventory[0].vpc_id;
  vpc.append(duplicate);
  options.onReconfigure?.(p);
  expect(window.location.hash).toBe("#/plans");
  duplicate.remove();
  const control = prepare(document);
  const reviewRoot = control?.parentElement?.parentElement;
  const list = document.querySelector("#plan-list");
  if (!control || !reviewRoot || !list?.contains(reviewRoot))
    throw new Error("Missing exact review controls");
  const formValues = () => ({
    vpc: vpc.value,
    network: document.querySelector<HTMLSelectElement>("#network")?.value,
    subnets: [...document.querySelectorAll<HTMLInputElement>("#subnets input")].map((input) => ({
      value: input.value,
      checked: input.checked,
    })),
    configureHidden: document.querySelector<HTMLElement>("#connection-configure")?.hidden,
    selectionHidden: document.querySelector<HTMLElement>("#connection-select")?.hidden,
  });
  const beforeRetirement = formValues();
  const refused = () => {
    options.onReconfigure?.(p);
    expect(formValues()).toEqual(beforeRetirement);
    expect(window.location.hash).toBe("#/plans");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  };
  control.disabled = true;
  refused();
  control.disabled = false;
  const card = control.parentElement;
  if (!card) throw new Error("Missing original action parent");
  control.remove();
  refused();
  card.append(control);
  document.body.append(control);
  refused();
  card.append(control);
  reviewRoot.remove();
  refused();
  list.append(reviewRoot);
  document.body.append(reviewRoot);
  refused();
  list.append(reviewRoot);
  options.onReconfigure?.(p);
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>("#connection-configure")?.hidden).toBe(false),
  );
  expect(window.location.hash).toBe("#/connections");
  expect(
    [...document.querySelectorAll<HTMLInputElement>("#subnets input:checked")].map((input) => input.value),
  ).toEqual(p.request.subnet_ids);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  vi.doUnmock("./plan-review-view");
});

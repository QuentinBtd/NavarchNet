import { afterEach, expect, it, vi } from "vitest";
import type { Inventory, Plan, RegionalNetwork, Snapshot } from "./generated";
import { renderNetworkWorkspace } from "./network-workspace";
import type { renderPlanReview } from "./plan-review-view";

function fixture() {
  const network: RegionalNetwork = {
    id: "network",
    name: "Current network",
    region: "eu-west-1",
    revision: 3,
    egress_cidr: "10.250.0.0/16",
    az_ids: ["az-a", "az-b"],
    public_ips: [],
    application_cidrs: [],
    managed_nat: true,
  };
  const inventory: Inventory = {
    account_id: "account",
    vpc_id: "vpc",
    region: "eu-west-1",
    cidr: "10.24.0.0/16",
    revision: 4,
    subnets: [
      { id: "not-requested", az_id: "az-a", route_table: "rtb-a", default_route_managed: true },
      { id: "requested", az_id: "az-b", route_table: "rtb-b", default_route_managed: true },
    ],
  };
  const plan: Plan = {
    id: "older-plan",
    digest: "original-digest",
    scope: "scope",
    scope_version: 0,
    inventory_revision: 1,
    network_revision: 1,
    request: {
      account_id: "account",
      vpc_id: "vpc",
      network_id: "network",
      subnet_ids: ["requested"],
      allow_application_traffic: false,
    },
    actions: [],
  };
  const data: Pick<Snapshot, "accounts" | "inventory" | "networks" | "plans"> = {
    accounts: [
      { id: "account", name: "Current account", provider: "fake", revision: 1, role_arn: "fake:role" },
    ],
    inventory: [inventory],
    networks: [network],
    plans: [{ ...structuredClone(plan), id: "newer-plan" }, plan],
  };
  return { data, plan, inventory, network };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.doUnmock("./network-workspace");
  vi.doUnmock("./plan-review-view");
});

it("distinguishes the located original requested subset from current returned map metadata without mutation", () => {
  const { data, plan } = fixture();
  const before = structuredClone(data);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const options = {
    selection: { networkId: "network", inventoryKey: JSON.stringify(["account", "vpc"]) },
    plans: data.plans,
    requestedPlan: plan,
    isCurrent: () => true,
    onSelection: vi.fn(),
    canConfigure: false,
  };
  const root = renderNetworkWorkspace(data, options);
  document.body.append(root);
  const context = root.querySelector<HTMLElement>('[aria-label="Original plan requested subnets"]');
  expect(context).not.toBeNull();
  expect(context?.dataset.planId).toBe("older-plan");
  expect(context?.dataset.planDigest).toBe("original-digest");
  expect([...root.querySelectorAll("[data-requested-subnet]")].map((node) => node.textContent)).toEqual([
    "requested",
  ]);
  expect(
    [...root.querySelectorAll<HTMLElement>("[data-plan-requested-subnet]")].map(
      (node) => node.dataset.planRequestedSubnet,
    ),
  ).toEqual(["requested"]);
  expect(context?.textContent).toContain("not historical membership or an applied connection");
  expect(data).toEqual(before);
  expect(fetcher).not.toHaveBeenCalled();
});

it("validates whole original/current context and retires replaced renderer bindings without turning form gates into read gates", () => {
  const mount = (value = fixture()) => {
    const options = {
      selection: {
        networkId: value.network.id,
        inventoryKey: JSON.stringify([value.inventory.account_id, value.inventory.vpc_id]),
      },
      plans: value.data.plans,
      requestedPlan: value.plan,
      isCurrent: () => true,
      onSelection: vi.fn(),
    };
    const root = renderNetworkWorkspace(value.data, options);
    document.body.append(root);
    return { ...value, root, options };
  };
  const redraw = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>(`[aria-label="Inspect application VPC vpc"]`)?.click();
  const invalid: ((value: ReturnType<typeof fixture>) => void)[] = [
    (value) => {
      value.plan.request.subnet_ids = [];
    },
    (value) => {
      value.plan.request.subnet_ids = ["requested", "requested"];
    },
    (value) => {
      value.plan.request.subnet_ids.length = 1001;
    },
    (value) => {
      value.plan.request.subnet_ids.length = 3;
    },
    (value) => {
      value.plan.request = Object.create(value.plan.request);
    },
    (value) => {
      Reflect.deleteProperty(value.plan, "digest");
    },
    (value) => {
      value.data.plans.push({ ...value.plan });
    },
    (value) => {
      value.data.plans.length = 100;
    },
  ];
  for (const mutate of invalid) {
    const value = fixture();
    mutate(value);
    const { root } = mount(value);
    expect(root.querySelectorAll("[data-plan-requested-subnet], [data-requested-subnet]")).toHaveLength(0);
  }
  for (const duplicate of [false, true]) {
    const value = fixture();
    value.plan.request.subnet_ids = ["not-requested", "missing"];
    if (duplicate) {
      value.plan.request.subnet_ids = ["requested"];
      value.inventory.subnets.push({ ...value.inventory.subnets[0] });
    }
    const { root } = mount(value);
    expect([...root.querySelectorAll("[data-requested-subnet]")].map((node) => node.textContent)).toEqual(
      value.plan.request.subnet_ids,
    );
    expect(root.querySelectorAll("[data-plan-requested-subnet]")).toHaveLength(0);
    expect(root.textContent).toContain("Current requested-subnet match unavailable or ambiguous");
  }
  const representable = fixture();
  representable.plan.request.allow_application_traffic = true;
  representable.data.accounts.push({ ...representable.data.accounts[0], id: "another-account" });
  representable.data.inventory.unshift({ ...representable.inventory, account_id: "another-account" });
  const accepted = mount(representable);
  expect(accepted.root.querySelectorAll("[data-plan-requested-subnet]")).toHaveLength(1);
  const mutations: ((value: ReturnType<typeof mount>) => void)[] = [
    (value) => {
      value.plan.id = "changed";
    },
    (value) => {
      value.plan.digest = "changed";
    },
    (value) => {
      value.plan.request = structuredClone(value.plan.request);
    },
    (value) => {
      value.plan.request.subnet_ids = [...value.plan.request.subnet_ids];
    },
    (value) => {
      value.plan.request.subnet_ids[0] = "not-requested";
    },
    (value) => {
      value.options.requestedPlan = { ...value.plan };
    },
    (value) => {
      value.options.plans = [...value.options.plans];
    },
  ];
  for (const mutate of mutations) {
    const value = mount();
    mutate(value);
    redraw(value.root);
    expect(value.root.querySelectorAll("[data-plan-requested-subnet], [data-requested-subnet]")).toHaveLength(
      0,
    );
    expect(value.root.textContent).toContain("Original requested-subnet context unavailable");
  }
});

it("the real parent binds exact original request context and retires its getter on refresh, scope change and logout", async () => {
  vi.resetModules();
  let review: { plans: Plan[]; options: Parameters<typeof renderPlanReview>[1] } | undefined;
  let mapOptions: Parameters<typeof renderNetworkWorkspace>[1] | undefined;
  vi.doMock("./plan-review-view", async () => {
    const real = await vi.importActual<typeof import("./plan-review-view")>("./plan-review-view");
    return {
      ...real,
      renderPlanReview: (plans: Plan[], options: Parameters<typeof renderPlanReview>[1]) => {
        review = { plans, options };
        return real.renderPlanReview(plans, options);
      },
    };
  });
  vi.doMock("./network-workspace", async () => {
    const real = await vi.importActual<typeof import("./network-workspace")>("./network-workspace");
    return {
      ...real,
      renderNetworkWorkspace: (
        data: Parameters<typeof renderNetworkWorkspace>[0],
        options: Parameters<typeof renderNetworkWorkspace>[1],
      ) => {
        mapOptions = options;
        return real.renderNetworkWorkspace(data, options);
      },
    };
  });
  const state = (): Snapshot => {
    const data = fixture().data;
    const network = data.networks[0];
    if (!network) throw new Error("Missing fixture network");
    data.networks.push({ ...network, id: "another-network", name: "Other current network" });
    return {
      ...data,
      role: "read_only",
      mode: "demo",
      operations: [],
      aws_accounts: [],
      aws_regions: [],
      aws_read_only_enabled: false,
    };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/snapshot") throw new Error(`Unexpected request ${input}`);
      return new Response(JSON.stringify(state()));
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/plans");
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token"),
    login = document.querySelector("#login");
  if (!token || !login) throw new Error("Missing login");
  token.value = "fixture-reader";
  login.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#plans")?.hidden).toBe(false));
  const select = document.querySelector<HTMLSelectElement>("#plan-selection");
  if (!select) throw new Error("Missing selected plan");
  select.value = "older-plan";
  select.dispatchEvent(new Event("change"));
  if (!review?.options.workspaceSnapshot) throw new Error("Missing original parent snapshot");
  const { plans, options } = review,
    source = options.workspaceSnapshot;
  if (!source) throw new Error("Missing original parent source");
  const original = plans.find((plan) => plan.id === "older-plan"),
    inventory = source.inventory[0],
    network = source.networks[0];
  if (!original || !inventory || !network) throw new Error("Missing original parent records");
  const calls = vi.mocked(fetch).mock.calls.length;
  options.onLocateScope?.(original, inventory, network);
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#networks")?.hidden).toBe(false));
  const focused = mapOptions;
  if (!focused) throw new Error("Missing focused map");
  expect(focused.requestedPlan).toBe(original);
  const request = original.request,
    ids = request.subnet_ids,
    digest = original.digest,
    id = original.id;
  original.digest = "changed";
  expect(focused.requestedPlan).toBeNull();
  original.digest = digest;
  original.id = "changed";
  expect(focused.requestedPlan).toBeNull();
  original.id = id;
  original.request = structuredClone(request);
  expect(focused.requestedPlan).toBeNull();
  original.request = request;
  request.subnet_ids = [...ids];
  expect(focused.requestedPlan).toBeNull();
  request.subnet_ids = ids;
  ids[0] = "not-requested";
  expect(focused.requestedPlan).toBeNull();
  ids[0] = "requested";
  const originalPlans = source.plans;
  source.plans = [...originalPlans];
  expect(focused.requestedPlan).toBeNull();
  source.plans = originalPlans;
  expect(focused.requestedPlan).toBe(original);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(calls + 1));
  await vi.waitFor(() => expect(mapOptions).not.toBe(focused));
  expect(focused.requestedPlan).toBeNull();
  expect(document.querySelectorAll("[data-plan-requested-subnet]")).toHaveLength(0);
  window.location.hash = "#/plans";
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#plans")?.hidden).toBe(false));
  const selector = document.querySelector<HTMLSelectElement>("#plan-selection");
  if (!selector) throw new Error("Missing refreshed plan selector");
  selector.value = "older-plan";
  selector.dispatchEvent(new Event("change"));
  const fresh = review;
  if (!fresh?.options.workspaceSnapshot) throw new Error("Missing refreshed original plan context");
  const freshPlan = fresh.plans.find((plan) => plan.id === "older-plan"),
    freshInventory = fresh.options.workspaceSnapshot.inventory[0],
    freshNetwork = fresh.options.workspaceSnapshot.networks[0];
  if (!freshPlan || !freshInventory || !freshNetwork) throw new Error("Missing refreshed original records");
  fresh.options.onLocateScope?.(freshPlan, freshInventory, freshNetwork);
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#networks")?.hidden).toBe(false));
  const freshMap = mapOptions;
  if (!freshMap) throw new Error("Missing refreshed focused map");
  expect(freshMap.requestedPlan).toBe(freshPlan);
  focused.onSelection({ networkId: "retired-network", inventoryKey: "retired-scope" });
  expect(freshMap.requestedPlan).toBe(freshPlan);
  const networkChoice = document.querySelector<HTMLSelectElement>("#workspace-network");
  if (!networkChoice) throw new Error("Missing current network choice");
  networkChoice.value = "another-network";
  networkChoice.dispatchEvent(new Event("change"));
  expect(freshMap.requestedPlan).toBeUndefined();
  expect(document.querySelectorAll("[data-plan-requested-subnet], [data-requested-subnet]")).toHaveLength(0);
  window.location.hash = "#/plans";
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#plans")?.hidden).toBe(false));
  const lastReview = review;
  if (!lastReview?.options.workspaceSnapshot) throw new Error("Missing reselection context");
  const lastPlan = lastReview.plans.find((plan) => plan.id === "older-plan"),
    lastInventory = lastReview.options.workspaceSnapshot.inventory[0],
    lastNetwork = lastReview.options.workspaceSnapshot.networks[0];
  if (!lastPlan || !lastInventory || !lastNetwork) throw new Error("Missing original reselection records");
  lastReview.options.onLocateScope?.(lastPlan, lastInventory, lastNetwork);
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#networks")?.hidden).toBe(false));
  expect(mapOptions?.requestedPlan).toBe(lastPlan);
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  expect(mapOptions?.requestedPlan).toBeUndefined();
});

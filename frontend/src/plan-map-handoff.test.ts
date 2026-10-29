import { afterEach, expect, it, vi } from "vitest";
import type { Plan, Snapshot } from "./generated";
import { workspaceForPlan } from "./network-workspace";
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
function locate(root: ParentNode) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Locate requested scope on map",
  );
}
it("locates the exact original saved request in returned map context without enriching or mutating the plan", () => {
  const source = state(),
    original = source.plans[1],
    before = structuredClone(source),
    onLocateScope = vi.fn();
  const root = renderPlanReview(source.plans, {
    selectedPlanId: original.id,
    isCurrent: () => true,
    onSelect: vi.fn(),
    makeApply: () => document.createElement("button"),
    workspaceSnapshot: source,
    onLocateScope,
  });
  document.body.append(root);
  const control = locate(root);
  expect(control).toBeDefined();
  if (!control) throw new Error("Missing map handoff");
  expect(control.disabled).toBe(false);
  control.click();
  expect(onLocateScope).toHaveBeenCalledExactlyOnceWith(original, source.inventory[0], source.networks[0]);
  expect(root.textContent).toContain("Returned map metadata, not current connection or plan validity");
  expect(source).toEqual(before);
});

it("rejects ambiguous or unavailable returned scopes and retires retained map controls", () => {
  const mutations: ((s: Snapshot) => void)[] = [
    (s) => {
      s.inventory = [];
    },
    (s) => {
      s.networks = [];
    },
    (s) => {
      s.inventory.push({ ...s.inventory[0] });
    },
    (s) => {
      s.networks.push({ ...s.networks[0] });
    },
    (s) => {
      s.plans.push({ ...s.plans[1] });
    },
    (s) => {
      s.accounts.push({ ...s.accounts[0] });
    },
    (s) => {
      s.inventory[0].region = "other";
    },
    (s) => {
      s.accounts[0].provider = "aws";
    },
    (s) => {
      s.plans.length = 80;
    },
    (s) => {
      s.inventory.length = 80;
    },
    (s) => {
      s.networks.length = 80;
    },
    (s) => {
      s.accounts.length = 80;
    },
    (s) => {
      s.plans[1].request = Object.assign(Object.create({ account_id: "app" }), { ...s.plans[1].request });
      delete (s.plans[1].request as Partial<Plan["request"]>).account_id;
    },
  ];
  for (const mutate of mutations) {
    const s = state(),
      p = s.plans[1];
    mutate(s);
    expect(workspaceForPlan(s, p)).toBeUndefined();
  }
  const s = state(),
    p = s.plans[1];
  expect(workspaceForPlan(s, { ...p })).toBeUndefined();
  s.accounts.push({ ...s.accounts[0], id: "other-account" });
  s.inventory.unshift({ ...s.inventory[0], account_id: "other-account" });
  expect(workspaceForPlan(s, p)?.inventory).toBe(s.inventory[1]);
  const calls = vi.fn();
  let current = true;
  const root = renderPlanReview(s.plans, {
    selectedPlanId: p.id,
    isCurrent: () => current,
    onSelect: vi.fn(),
    makeApply: () => document.createElement("button"),
    workspaceSnapshot: s,
    onLocateScope: calls,
  });
  document.body.append(root);
  const control = locate(root);
  if (!control) throw new Error("Missing map handoff");
  control.disabled = true;
  control.dispatchEvent(new MouseEvent("click"));
  control.disabled = false;
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

it("the real parent rejects forged and replaced source references while readers can locate the exact nondefault plan", async () => {
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
  if (!select) throw new Error("Missing plan selector");
  select.value = "older";
  select.dispatchEvent(new Event("change"));
  if (!captured?.options.workspaceSnapshot) throw new Error("Missing parent capture");
  const { plans, options } = captured,
    s = options.workspaceSnapshot;
  if (!s) throw new Error("Missing original snapshot");
  const p = plans[1],
    i = s.inventory[0],
    n = s.networks[0],
    calls = vi.mocked(fetch).mock.calls.length;
  options.onLocateScope?.({ ...p }, i, n);
  expect(window.location.hash).toBe("#/plans");
  options.onLocateScope?.(p, i, s.networks[1]);
  expect(window.location.hash).toBe("#/plans");
  s.inventory[0] = { ...i };
  options.onLocateScope?.(p, s.inventory[0], n);
  expect(window.location.hash).toBe("#/plans");
  s.inventory[0] = i;
  s.plans[1] = { ...p };
  options.onLocateScope?.(s.plans[1], i, n);
  expect(window.location.hash).toBe("#/plans");
  s.plans[1] = p;
  options.onLocateScope?.(p, i, n);
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#networks")?.hidden).toBe(false));
  expect(document.querySelector<HTMLSelectElement>("#workspace-network")?.value).toBe(n.id);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  vi.doUnmock("./plan-review-view");
});

import { afterEach, expect, it, vi } from "vitest";
import type { Plan, Snapshot } from "./generated";
import { renderNetworkWorkspace } from "./network-workspace";

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
function select(root: ParentNode, id: string, value: string) {
  const node = root.querySelector<HTMLSelectElement>(`#${id}`);
  if (!node) throw new Error(`Missing selector ${id}`);
  node.value = value;
  node.dispatchEvent(new Event("change"));
}
function review(root: ParentNode) {
  const node = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Review selected saved plan",
  );
  if (!node) throw new Error("Missing saved-plan review");
  return node;
}
function mount(data: Snapshot, current = () => true) {
  const onReviewPlan = vi.fn(),
    onConfigure = vi.fn();
  const root = renderNetworkWorkspace(data, {
    selection: {},
    isCurrent: current,
    onSelection: vi.fn(),
    plans: data.plans,
    onReviewPlan,
    onConfigure,
    canConfigure: false,
  });
  document.body.append(root);
  return { root, onReviewPlan, onConfigure };
}
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}
async function boot(data: Snapshot, route = "#/plans") {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", route);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/snapshot") throw new Error(`Unexpected handoff request ${input}`);
      return new Response(JSON.stringify(data));
    }),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-reader";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(node("#workspace").hidden).toBe(false));
  await vi.waitFor(() =>
    expect(document.querySelectorAll("#workspace-network option")).toHaveLength(data.networks.length),
  );
}
async function networks() {
  node<HTMLAnchorElement>('nav a[href="#/networks"]').click();
  await vi.waitFor(() => expect(node("#networks").hidden).toBe(false));
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("explicitly reviews only original plans requesting the exact selected account, VPC and network without writes", () => {
  const data = state();
  data.plans.push(
    { ...plan("other-account"), request: { ...plan("other-account").request, account_id: "other" } },
    { ...plan("other-vpc"), request: { ...plan("other-vpc").request, vpc_id: "different" } },
  );
  const before = structuredClone(data);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected map request");
    }),
  );
  const { root, onReviewPlan, onConfigure } = mount(data);
  const picker = root.querySelector<HTMLSelectElement>("#workspace-plan");
  expect(picker).not.toBeNull();
  if (!picker) throw new Error("Missing saved-plan picker");
  expect([...picker.options].map((o) => o.value)).toEqual(["", "newer", "older"]);
  expect(picker.value).toBe("");
  expect(review(root).disabled).toBe(true);
  expect(root.querySelector("aside")?.textContent).toContain("2 matching returned plans");
  expect(root.querySelector("aside")?.textContent).toContain("not current validity or applied connectivity");
  select(root, "workspace-plan", "older");
  expect(review(root).disabled).toBe(false);
  review(root).click();
  expect(onReviewPlan).toHaveBeenCalledWith(data.plans[1], data.inventory[0], data.networks[0]);
  expect(onReviewPlan.mock.calls[0][0]).toBe(data.plans[1]);
  expect(onConfigure).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(data).toEqual(before);
});

it("keeps unavailable bounded history atomic and retires replaced, disabled, detached and stale review controls", () => {
  const cases = [state(), state(), state(), state()];
  cases[0].plans.push({ ...cases[0].plans[1] });
  cases[1].plans.push(...Array.from({ length: 80 }, (_, i) => plan(`tail-${i}`)));
  delete cases[1].plans[82];
  cases[2].plans = Array(2) as Plan[];
  Object.setPrototypeOf(
    cases[2].plans,
    Object.assign(Object.create(Array.prototype), { 0: plan("inherited") }),
  );
  cases[3].plans[2].request.network_id = undefined as unknown as string;
  for (const data of cases) {
    const { root, onReviewPlan } = mount(data);
    expect(root.querySelector("aside")?.textContent).toContain("Saved plan context unavailable or ambiguous");
    expect(root.querySelector("#workspace-plan")).toBeNull();
    expect(onReviewPlan).not.toHaveBeenCalled();
    root.remove();
  }
  let current = true;
  const data = state(),
    { root, onReviewPlan } = mount(data, () => current);
  select(root, "workspace-plan", "older");
  const old = review(root),
    handler = old.onclick as (event: MouseEvent) => void;
  old.disabled = true;
  handler.call(old, new MouseEvent("click"));
  old.disabled = false;
  select(root, "workspace-vpc", JSON.stringify(["app", "vpc"]));
  handler.call(old, new MouseEvent("click"));
  select(root, "workspace-plan", "older");
  const selected = review(root),
    selectedHandler = selected.onclick as (event: MouseEvent) => void;
  data.plans[1].request.network_id = "different";
  selectedHandler.call(selected, new MouseEvent("click"));
  data.plans[1].request.network_id = "net";
  current = false;
  selectedHandler.call(selected, new MouseEvent("click"));
  current = true;
  selected.remove();
  selectedHandler.call(selected, new MouseEvent("click"));
  expect(onReviewPlan).not.toHaveBeenCalled();
  root.remove();
  const { root: empty } = mount({ ...state(), plans: [] });
  expect(empty.querySelector("aside")?.textContent).toContain("No matching plan in returned history");
  expect(empty.querySelector("#workspace-plan")).toBeNull();
});

it("main opens an explicitly chosen older exact plan for a reader and ignores retired snapshot/logout controls", async () => {
  vi.resetModules();
  const data = state(),
    before = structuredClone(data);
  await boot(data);
  await vi.waitFor(() => expect(document.querySelectorAll("#plan-list article")).toHaveLength(1));
  select(document, "plan-selection", "different-plan");
  await networks();
  const calls = vi.mocked(fetch).mock.calls.length;
  select(document, "workspace-plan", "older");
  review(node("#network-list")).click();
  expect(location.hash).toBe("#/plans");
  expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("older");
  expect(document.querySelector("#plan-list")?.textContent).toContain(data.plans[1].digest);
  expect(document.querySelector<HTMLButtonElement>("#plan-list button[data-write]")?.disabled).toBe(true);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  await networks();
  select(document, "workspace-plan", "older");
  const old = review(node("#network-list")),
    handler = old.onclick as (event: MouseEvent) => void;
  node("#refresh").click();
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(calls + 1));
  await vi.waitFor(() => expect(old.isConnected).toBe(false));
  handler.call(old, new MouseEvent("click"));
  expect(location.hash).toBe("#/networks");
  node("#logout").click();
  handler.call(old, new MouseEvent("click"));
  expect(document.querySelector("#plan-list article")).toBeNull();
  expect(data).toEqual(before);
});

it("main independently rejects forged references, off-map scopes, post-render corruption and old snapshot callbacks", async () => {
  // GREEN-only callback qualification, not a new HTTP corruption RED.
  vi.resetModules();
  const component = await import("./network-workspace");
  const original = component.renderNetworkWorkspace;
  const captured: { data: Snapshot; options: Parameters<typeof original>[1] }[] = [];
  vi.spyOn(component, "renderNetworkWorkspace").mockImplementation((data, options) => {
    captured.push({ data: data as Snapshot, options });
    return original(data, options);
  });
  const fixture = state();
  fixture.accounts.push({ ...fixture.accounts[0], id: "other", name: "Other application" });
  fixture.inventory.push({ ...fixture.inventory[0], account_id: "other" });
  fixture.plans.push({
    ...plan("other-account"),
    request: { ...plan("other-account").request, account_id: "other" },
  });
  await boot(fixture, "#/networks");
  const { data, options } = captured.at(-1) ?? {};
  if (!data || !options?.onReviewPlan) throw new Error("Missing parent callback");
  const callback = options.onReviewPlan,
    p = data.plans[1],
    inventory = data.inventory[0],
    network = data.networks[0];
  const before = structuredClone(data),
    calls = vi.mocked(fetch).mock.calls.length;
  callback({ ...p }, inventory, network);
  callback(p, { ...inventory }, network);
  callback(p, inventory, { ...network });
  callback(data.plans[2], inventory, network);
  callback(data.plans[3], data.inventory[1], network);
  data.plans.push({ ...p });
  callback(p, inventory, network);
  data.plans.pop();
  p.request.network_id = "different";
  callback(p, inventory, network);
  p.request.network_id = "net";
  data.plans[1] = structuredClone(p);
  callback(p, inventory, network);
  data.plans[1] = p;
  select(document, "workspace-network", "different");
  callback(p, inventory, network);
  expect(location.hash).toBe("#/networks");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  expect(data).toEqual(before);
  node("#refresh").click();
  await vi.waitFor(() => expect(captured.at(-1)?.data).not.toBe(data));
  callback(p, inventory, network);
  expect(location.hash).toBe("#/networks");
  node("#logout").click();
  callback(p, inventory, network);
  expect(document.querySelector("#plan-list article")).toBeNull();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls + 1);
});

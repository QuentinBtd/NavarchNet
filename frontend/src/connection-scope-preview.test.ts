import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionRequest, Plan, Snapshot } from "./generated";

const initial = (): Snapshot => ({
  accounts: [
    { id: "app-a", name: "First application", provider: "fake", revision: 1, role_arn: "fake:role" },
    { id: "app-b", name: "Second application", provider: "fake", revision: 1, role_arn: "fake:role" },
  ],
  inventory: ["a", "b"].map((id) => ({
    account_id: `app-${id}`,
    vpc_id: `vpc-${id}`,
    region: "eu-west-1",
    cidr: id === "a" ? "10.10.0.0/16" : "10.20.0.0/16",
    revision: 1,
    subnets: [1, 2].map((i) => ({
      id: `subnet-${id}-${i}`,
      az_id: `az-${i}`,
      route_table: id === "b" ? "table-shared" : `table-a-${i}`,
      default_route_managed: true,
    })),
  })),
  networks: ["first", "second"].map((id) => ({
    id,
    name: `Declared ${id}`,
    region: "eu-west-1",
    revision: 1,
    egress_cidr: "10.250.0.0/16",
    az_ids: ["az-1", "az-2"],
    public_ips: [],
    application_cidrs: [],
    managed_nat: true,
  })),
  plans: [],
  operations: [],
  role: "admin",
  mode: "demo",
  aws_accounts: [],
  aws_regions: [],
  aws_read_only_enabled: false,
});
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
}
const select = (id: string, value: string) => {
  node<HTMLSelectElement>(id).value = value;
  node(id).dispatchEvent(new Event("change"));
};
const preview = () => node('[aria-label="Selected attachment scope"]');
const ids = () =>
  [...preview().querySelectorAll<HTMLElement>("[data-selected-subnet]")].map((n) => n.dataset.selectedSubnet);
const configure = () => node<HTMLButtonElement>("#configure-connection").click();
afterEach(() => {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("explains the exact selected attachment scope before explicit generation and preserves the original generated Plan request", async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/connections");
  const data = initial(),
    before = structuredClone(data);
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let generated: Plan | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input),
        method = init?.method ?? "GET";
      calls.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === "/api/v1/snapshot") return new Response(JSON.stringify(data));
      if (path === "/api/v1/plans" && method === "POST") {
        const request = JSON.parse(String(init?.body)) as ConnectionRequest;
        generated = {
          id: "explicit-original-plan",
          scope: "app-b:vpc-b",
          scope_version: 0,
          inventory_revision: 1,
          network_revision: 1,
          request,
          actions: [{ kind: "attachment", target: "vpc-b", requires: [], postcondition: "Simulation only" }],
          digest: "original-digest",
        };
        data.plans = [generated];
        return new Response(JSON.stringify(generated));
      }
      throw new Error(`Unexpected scope-preview request ${path}`);
    }),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-admin";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(node<HTMLSelectElement>("#vpc").options).toHaveLength(2));
  select("#vpc", "vpc-b");
  configure();
  await vi.waitFor(() => expect(node("#connection-configure").hidden).toBe(false));
  expect(
    node("#connection-configure").textContent,
    "Configure must explain the selected attachment scope before Generate",
  ).toContain("Selected attachment scope");
  expect(preview().dataset.vpcId).toBe("vpc-b");
  expect(preview().textContent).toContain("app-b");
  expect(preview().textContent).toContain("10.20.0.0/16");
  expect(preview().textContent).toContain("2 selected attachment subnets");
  expect(preview().textContent).toContain("2 reported AZ IDs");
  expect(preview().textContent).toContain("1 reported route tables");
  expect(preview().textContent).toContain("table-shared");
  expect(preview().textContent).toContain("not a generated plan");
  expect(ids()).toEqual(["subnet-b-1", "subnet-b-2"]);
  expect(calls).toEqual([{ path: "/api/v1/snapshot", method: "GET" }]);
  expect(data).toEqual(before);
  const one = node<HTMLInputElement>('#subnets input[value="subnet-b-1"]');
  one.checked = false;
  one.dispatchEvent(new Event("change"));
  expect(ids()).toEqual(["subnet-b-2"]);
  expect(preview().textContent).toContain("1 selected attachment subnets");
  expect(preview().textContent).toContain("1 reported AZ IDs");
  expect(preview().textContent).not.toContain("subnet-b-1");
  node<HTMLButtonElement>("#connection-back").click();
  expect(document.querySelector('[aria-label="Selected attachment scope"]')).toBeNull();
  configure();
  expect(ids()).toEqual(["subnet-b-2"]);
  select("#network", "second");
  expect(node('[aria-label="Selected regional network"]').dataset.networkId).toBe("second");
  expect(preview().dataset.vpcId).toBe("vpc-b");
  expect(ids()).toEqual(["subnet-b-2"]);
  expect(calls).toHaveLength(1);
  expect(data).toEqual(before);
  node("#plan-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
  expect(calls.filter((c) => c.method === "POST")).toEqual([
    {
      path: "/api/v1/plans",
      method: "POST",
      body: {
        account_id: "app-b",
        vpc_id: "vpc-b",
        network_id: "second",
        subnet_ids: ["subnet-b-2"],
        allow_application_traffic: false,
      },
    },
  ]);
  expect(JSON.parse(node("#plan-list article details pre").textContent ?? "null")).toEqual(generated);
  expect(data.operations).toEqual([]);
  const originalPlan = structuredClone(generated);
  // Existing explicit preparation is reused, not a new Generate/retry path.
  node<HTMLButtonElement>("#plan-list [data-plan-reconfigure]").click();
  await vi.waitFor(() => expect(node("#connect").hidden).toBe(false));
  expect(ids()).toEqual(["subnet-b-2"]);
  expect(preview().textContent).toContain("1 selected attachment subnets");
  node<HTMLButtonElement>("#refresh").click();
  await vi.waitFor(() => expect(calls.filter((c) => c.path === "/api/v1/snapshot")).toHaveLength(3));
  await vi.waitFor(() => expect(ids()).toEqual(["subnet-b-1", "subnet-b-2"]));
  expect(data.plans).toEqual([originalPlan]);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  node<HTMLButtonElement>("#logout").click();
  expect(document.querySelector('[aria-label="Selected attachment scope"]')).toBeNull();
});

it("keeps returned placement counts distinct from planning and bounds only the local preview, never the selection", async () => {
  const { renderConnectionScopePreview } = await import("./connection-scope-preview");
  const inventory = initial().inventory[1];
  inventory.subnets = Array.from({ length: 8 }, (_, i) => ({
    id: `literal-${i}`,
    az_id: "same-reported-az",
    route_table: "<table-literal>",
    default_route_managed: false,
  }));
  const chosen = inventory.subnets.map((s) => s.id).reverse();
  const before = structuredClone({ inventory, chosen });
  const root = renderConnectionScopePreview(inventory, chosen);
  expect(root.dataset.vpcId).toBe(inventory.vpc_id);
  expect(root.textContent).toContain(
    "8 selected attachment subnets · 1 reported AZ IDs · 1 reported route tables",
  );
  expect(root.textContent).toContain("Showing 6 of 8");
  expect(
    [...root.querySelectorAll<HTMLElement>("[data-selected-subnet]")].map((n) => n.dataset.selectedSubnet),
  ).toEqual(chosen.slice(0, 6));
  expect(root.textContent).toContain("<table-literal>");
  expect(root.querySelector("table-literal")).toBeNull();
  expect(root.textContent).toContain("not a generated plan or observed routing");
  expect(root.querySelector("button, input, select, a")).toBeNull();
  expect({ inventory, chosen }).toEqual(before);
  const empty = renderConnectionScopePreview(inventory, []);
  expect(empty.textContent).toContain("0 selected attachment subnets");
  expect(empty.textContent).toContain("No attachment subnet selected");
  expect(empty.querySelector("[data-selected-subnet]")).toBeNull();
});

it("publishes no selected prefix for unknown or ambiguous metadata while preserving literal current inventory", async () => {
  const { renderConnectionScopePreview } = await import("./connection-scope-preview");
  const inventory = initial().inventory[1];
  const duplicate = structuredClone(inventory);
  duplicate.subnets.push({ ...duplicate.subnets[0] });
  const sparse = structuredClone(inventory);
  sparse.subnets.length++;
  const missingTable = structuredClone(inventory);
  missingTable.subnets[1].route_table = undefined as unknown as string;
  const missingCidr = { ...inventory, cidr: undefined as unknown as string };
  for (const [source, selected] of [
    [undefined, []],
    [duplicate, ["subnet-b-1"]],
    [sparse, ["subnet-b-1"]],
    [missingTable, ["subnet-b-1"]],
    [missingCidr, ["subnet-b-1"]],
    [inventory, ["not-returned"]],
    [inventory, ["subnet-b-1", "subnet-b-1"]],
  ] as const) {
    const root = renderConnectionScopePreview(source, [...selected]);
    expect(root.textContent).toContain("unavailable or ambiguous");
    expect(root.querySelector("[data-selected-subnet]")).toBeNull();
    expect(root.dataset.vpcId).toBeUndefined();
  }
});

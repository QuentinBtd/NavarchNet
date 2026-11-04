import { afterEach, expect, it, vi } from "vitest";
import type { RegionalNetwork, Snapshot } from "./generated";

const network = (id: string): RegionalNetwork => ({
  id,
  name: `Declared ${id}`,
  region: "eu-west-1",
  revision: 3,
  egress_cidr: id === "a" ? "10.250.0.0/16" : "10.251.0.0/16",
  az_ids: ["az-one"],
  public_ips: [],
  application_cidrs: [],
  managed_nat: true,
});
const state = (): Snapshot => ({
  accounts: [{ id: "account", name: "Application", provider: "fake", revision: 1, role_arn: "fake:role" }],
  inventory: [
    {
      account_id: "account",
      vpc_id: "vpc",
      region: "eu-west-1",
      cidr: "10.0.0.0/16",
      revision: 1,
      subnets: [{ id: "subnet", az_id: "az-one", route_table: "table", default_route_managed: false }],
    },
  ],
  networks: [network("a"), network("b")],
  plans: [],
  operations: [],
  mode: "demo",
  role: "admin",
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
async function boot(data: Snapshot) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/connections");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/v1/snapshot")
        throw new Error(`Unexpected network context request ${input}`);
      return new Response(JSON.stringify(data));
    }),
  );
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  if (!token) throw new Error("Missing login");
  token.value = "fixture-admin";
  document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelectorAll("#vpc option")).toHaveLength(1));
  document.querySelector<HTMLButtonElement>("#configure-connection")?.click();
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>("#connection-configure")?.hidden).toBe(false),
  );
}
function choose(id: string) {
  const select = document.querySelector<HTMLSelectElement>("#network");
  if (!select) throw new Error("Missing network selector");
  select.value = id;
  select.dispatchEvent(new Event("change"));
}
const context = () => document.querySelector<HTMLElement>('[aria-label="Selected regional network"]');
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("shows the exact selected declared network without queries, inferred egress or provider HTML", async () => {
  const data = state();
  data.networks[1].name = "<img src=x onerror=alert(1)>";
  const before = structuredClone(data);
  await boot(data);
  const calls = vi.mocked(fetch).mock.calls.length;
  choose("b");
  expect(context()).not.toBeNull();
  expect(context()?.dataset.networkId).toBe("b");
  expect(context()?.textContent).toContain(data.networks[1].name);
  expect(context()?.textContent).toContain(data.networks[1].region);
  expect(context()?.textContent).toContain(data.networks[1].egress_cidr);
  expect(context()?.textContent).toContain("Snapshot revision 3");
  expect(context()?.textContent).toContain("not measured egress");
  expect(context()?.querySelector("img")).toBeNull();
  choose("a");
  expect(context()?.dataset.networkId).toBe("a");
  choose("b");
  expect(context()?.dataset.networkId).toBe("b");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  expect(data).toEqual(before);
});

it("refreshes same-ID context from the new snapshot and clears it on Back and logout", async () => {
  const data = state();
  await boot(data);
  choose("b");
  expect(context()).not.toBeNull();
  const oldContext = context();
  data.networks[1] = { ...data.networks[1], name: "New snapshot", egress_cidr: "10.252.0.0/16", revision: 8 };
  data.role = "read_only";
  const updated = structuredClone(data);
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(context()?.textContent).toContain("New snapshot"));
  expect(context()).not.toBe(oldContext);
  expect(context()?.dataset.networkId).toBe("b");
  expect(context()?.textContent).toContain("10.252.0.0/16");
  expect(context()?.textContent).toContain("Snapshot revision 8");
  expect(
    document.querySelector<HTMLButtonElement>("#connection-configure button[data-write]")?.disabled,
  ).toBe(true);
  expect(data).toEqual(updated);
  document.querySelector<HTMLButtonElement>("#connection-back")?.click();
  expect(document.querySelector("#connection-network-context")?.textContent).toBe("");
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  expect(document.querySelector("#connection-network-context")?.textContent).toBe("");
});

it("refuses duplicate or malformed identity context and ignores removed selector events", async () => {
  const cases = [state(), state(), state(), state()];
  cases[0].networks.push({ ...cases[0].networks[1] });
  cases[1].networks[1].egress_cidr = undefined as unknown as string;
  cases[2].networks[1].revision = Number.MAX_SAFE_INTEGER + 1;
  cases[3].networks.push(...Array.from({ length: 80 }, (_, i) => network(`other-${i}`)));
  cases[3].networks[81].id = undefined as unknown as string;
  for (const data of cases) {
    await boot(data);
    choose("b");
    expect(context()).not.toBeNull();
    expect(context()?.dataset.networkId).toBeUndefined();
    expect(context()?.textContent).toContain("unavailable or ambiguous");
    expect(context()?.querySelector("strong")).toBeNull();
  }
  await boot(state());
  choose("b");
  const current = context();
  const oldSelect = document.querySelector<HTMLSelectElement>("#network");
  if (!oldSelect) throw new Error("Missing network selector");
  const replacement = oldSelect.cloneNode(true) as HTMLSelectElement;
  oldSelect.replaceWith(replacement);
  oldSelect.value = "a";
  const calls = vi.mocked(fetch).mock.calls.length;
  oldSelect.dispatchEvent(new Event("change"));
  expect(context()).toBe(current);
  expect(context()?.dataset.networkId).toBe("b");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});

it("refuses complete sparse and inherited identity tails before exposing selected metadata", async () => {
  const { renderConnectionNetworkContext } = await import("./connection-network-context");
  const networks = [
    network("a"),
    network("b"),
    ...Array.from({ length: 80 }, (_, i) => network(`tail-${i}`)),
  ];
  const sparse = [...networks];
  sparse.length++;
  const inherited = [...networks];
  inherited.length++;
  Object.setPrototypeOf(
    inherited,
    Object.assign(Object.create(Array.prototype), { 82: network("inherited") }),
  );
  for (const rows of [sparse, inherited]) {
    const node = renderConnectionNetworkContext(rows, "b");
    expect(node.dataset.networkId).toBeUndefined();
    expect(node.textContent).toContain("unavailable or ambiguous");
    expect(node.querySelector("strong")).toBeNull();
  }
  const unknown = renderConnectionNetworkContext(networks, "missing");
  expect(unknown.dataset.networkId).toBeUndefined();
});

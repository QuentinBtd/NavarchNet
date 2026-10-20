import { afterEach, expect, it, vi } from "vitest";
import type {
  Snapshot,
  TgwLookupResponse,
  TgwSourceResponse,
  TgwTargetResponse,
  TopologyView,
  VerifiedAccount,
  VpcLookupResponse,
} from "./generated";

// Deferred credential-free HTTP responses through the real main.ts/session/renderer integration.
// Fetch intentionally ignores abort so generation/account checks must still protect the view.
const account = (id: string): VerifiedAccount => ({
  id,
  name: `Fixture ${id}`,
  role_arn: "arn:aws:iam::123456789012:role/Reader",
  aws_account_id: "123456789012",
  region: "eu-west-1",
  verified_at: "1",
  verified_session_name: "fixture",
  execution_enabled: false,
});
const snapshot: Snapshot = {
  accounts: [],
  inventory: [],
  networks: [],
  plans: [],
  operations: [],
  mode: "demo",
  role: "read_only",
  aws_accounts: [account("account-a"), account("account-b")],
  aws_read_only_enabled: false,
  aws_regions: [],
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function topology(id: string): TopologyView {
  return {
    topology: {
      id: `snapshot-${id}`,
      account_id: id,
      aws_account_id: "123456789012",
      region: "eu-west-1",
      started_at: "1",
      completed_at: "2",
      session_name: "fixture",
      request_ids: [],
      complete_for_supported_queries: true,
      limitations: [],
      execution_enabled: false,
      connectivity_tested: false,
      resources: [
        {
          kind: "transit_gateway_route_table",
          id: `table-${id}`,
          owner_account_id: null,
          vpc_id: null,
          subnet_id: null,
          az_id: null,
          state: "available",
          cidrs: [],
          public_ips: [],
          private_ips: [],
          tags: {},
          routes: [],
          associations: [],
          tgw_associations: null,
          tgw_propagations: null,
          tgw_routes: null,
          related_ids: [],
          connectivity_type: null,
          availability_mode: null,
          managed: false,
        },
      ],
    },
    adoptions: [],
    subnet_route_tables: [],
  };
}
const lookup: TgwLookupResponse = {
  topology_id: "snapshot-account-a",
  route_table_id: "table-account-a",
  destination: "203.0.113.1",
  result: {
    status: "reported_forward",
    destination_cidr: "0.0.0.0/0",
    route_type: "static",
    attachment_ids: ["old-lookup-attachment"],
  },
  execution_enabled: false,
  connectivity_tested: false,
};
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function boot(handler: (path: string) => Promise<Response>) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      return path === "/api/v1/snapshot" ? Promise.resolve(response(snapshot)) : handler(path);
    }),
  );
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  if (!token) throw new Error("Login input missing");
  token.value = "fixture-reader";
  document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelectorAll("#aws-account-list li")).toHaveLength(2));
}
function select(id: string) {
  const row = [...document.querySelectorAll("#aws-account-list li")].find((node) =>
    node.textContent?.includes(`Fixture ${id}`),
  );
  const button = row?.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("Saved account control missing");
  button.click();
}
function startLookup() {
  const form = document.querySelector<HTMLFormElement>("#aws-topology form[data-route-lookup]");
  const input = form?.querySelector<HTMLInputElement>("input");
  if (!form || !input) throw new Error("Saved lookup input missing");
  input.value = "203.0.113.1";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}
function vpcTopology(id: string): TopologyView {
  const view = topology(id);
  const row = view.topology.resources[0];
  if (!row) throw new Error("Fixture resource missing");
  view.topology.resources.push({ ...row, kind: "subnet", id: `subnet-${id}`, vpc_id: `vpc-${id}` });
  view.subnet_route_tables.push({
    subnet_id: `subnet-${id}`,
    vpc_id: `vpc-${id}`,
    selection: { status: "selected", route_table_id: `rtb-${id}`, source: "implicit_main" },
  });
  return view;
}
for (const change of ["account switch", "logout"] as const) {
  it(`late saved VPC lookup is discarded after ${change} even if fetch ignores abort`, async () => {
    const old = deferred();
    const calls: string[] = [];
    await boot(async (path) => {
      if (path.includes("vpc-route-lookup")) {
        calls.push(path);
        return old.promise;
      }
      return response(vpcTopology(path.includes("account-a") ? "account-a" : "account-b"));
    });
    select("account-a");
    await vi.waitFor(() => expect(document.querySelector("form[data-vpc-route-lookup]")).not.toBeNull());
    const form = document.querySelector<HTMLFormElement>("form[data-vpc-route-lookup]");
    const input = form?.querySelector<HTMLInputElement>("input");
    if (!form || !input) throw new Error("VPC lookup input missing");
    input.value = "203.0.113.1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(calls).toEqual([
      "/api/v1/aws/accounts/account-a/vpc-route-lookup?subnet_id=subnet-account-a&destination=203.0.113.1",
    ]);
    if (change === "account switch") {
      select("account-b");
      await vi.waitFor(() =>
        expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-b"),
      );
    } else document.querySelector<HTMLButtonElement>("#logout")?.click();
    const result: VpcLookupResponse = {
      topology_id: "snapshot-account-a",
      subnet_id: "subnet-account-a",
      destination: "203.0.113.1",
      result: {
        status: "reported",
        route_table_id: "rtb-account-a",
        source: "implicit_main",
        lookup: {
          status: "reported_route",
          destination_cidr: "0.0.0.0/0",
          origin: "CreateRoute",
          target: { kind: "transit_gateway", id: "tgw-old-vpc-response" },
        },
      },
      execution_enabled: false,
      connectivity_tested: false,
    };
    old.resolve(response(result));
    await new Promise((done) => setTimeout(done, 10));
    expect(document.querySelector("#aws-topology")?.textContent).not.toContain("tgw-old-vpc-response");
    if (change === "logout") {
      expect(document.querySelector("#aws-topology")?.childElementCount).toBe(0);
      expect(document.querySelector<HTMLElement>("#workspace")?.hidden).toBe(true);
    }
  });
}
for (const change of ["account switch", "logout"] as const) {
  it(`late source-to-TGW candidate is discarded after ${change} even if fetch ignores abort`, async () => {
    const old = deferred();
    const calls: string[] = [];
    await boot(async (path) => {
      if (path.includes("tgw-source-lookup")) {
        calls.push(path);
        return old.promise;
      }
      return response(vpcTopology(path.includes("account-a") ? "account-a" : "account-b"));
    });
    select("account-a");
    await vi.waitFor(() => expect(document.querySelector("form[data-vpc-route-lookup]")).not.toBeNull());
    const detail = [...document.querySelectorAll<HTMLDetailsElement>("#aws-topology details")].find(
      (node) => node.querySelector("summary")?.textContent === "Inspect saved source-to-TGW candidate",
    );
    if (!detail) throw new Error("Source candidate detail missing");
    expect(detail.querySelector("form")).toBeNull();
    detail.open = true;
    detail.dispatchEvent(new Event("toggle"));
    const form = detail.querySelector<HTMLFormElement>("form");
    const input = form?.querySelector("input");
    const network = form?.querySelector("select");
    if (!form || !input || !network) throw new Error("Source candidate controls missing");
    network.value = "account-b";
    input.value = "203.0.113.1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(calls).toEqual([
      "/api/v1/aws/accounts/account-a/tgw-source-lookup?network_account_id=account-b&subnet_id=subnet-account-a&destination=203.0.113.1",
    ]);
    if (change === "account switch") {
      select("account-b");
      await vi.waitFor(() =>
        expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-b"),
      );
    } else document.querySelector<HTMLButtonElement>("#logout")?.click();
    const result: TgwSourceResponse = {
      source_topology_id: "snapshot-account-a",
      network_topology_id: "snapshot-account-b",
      source_completed_at: "2",
      network_completed_at: "4",
      network_account_id: "account-b",
      subnet_id: "subnet-account-a",
      destination: "203.0.113.1",
      execution_enabled: false,
      connectivity_tested: false,
      result: {
        source: {
          status: "reported",
          route_table_id: "rtb-account-a",
          source: "implicit_main",
          lookup: {
            status: "reported_route",
            destination_cidr: "0.0.0.0/0",
            origin: "CreateRoute",
            target: { kind: "transit_gateway", id: "tgw-old-source-response" },
          },
        },
        handoff: {
          status: "reported_candidate",
          transit_gateway_id: "tgw-old-source-response",
          ingress_attachment_id: "ingress-old",
          attachment_subnet_id: "subnet-attachment",
          az_id: "euw1-az1",
          route_table_id: "tgw-table",
          lookup: {
            status: "reported_forward",
            destination_cidr: "0.0.0.0/0",
            route_type: "static",
            attachment_ids: ["egress"],
          },
        },
      },
    };
    old.resolve(response(result));
    await new Promise((done) => setTimeout(done, 10));
    expect(document.querySelector("#aws-topology")?.textContent).not.toContain("tgw-old-source-response");
    if (change === "logout") expect(document.querySelector("#aws-topology")?.childElementCount).toBe(0);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((done) => setTimeout(done, 10));
    expect(calls).toHaveLength(1);
  });
}
for (const change of ["account switch", "logout"] as const) {
  it(`late target entries and retained handlers are discarded after ${change} despite ignored abort`, async () => {
    const old = deferred();
    const calls: string[] = [];
    const source: TgwSourceResponse = {
      source_topology_id: "snapshot-account-a",
      network_topology_id: "snapshot-account-b",
      source_completed_at: "2",
      network_completed_at: "4",
      network_account_id: "account-b",
      subnet_id: "subnet-account-a",
      destination: "203.0.113.1",
      execution_enabled: false,
      connectivity_tested: false,
      result: {
        source: {
          status: "reported",
          route_table_id: "rtb-account-a",
          source: "implicit_main",
          lookup: {
            status: "reported_route",
            destination_cidr: "0.0.0.0/0",
            origin: "CreateRoute",
            target: { kind: "transit_gateway", id: "tgw-target" },
          },
        },
        handoff: {
          status: "reported_candidate",
          transit_gateway_id: "tgw-target",
          ingress_attachment_id: "ingress",
          attachment_subnet_id: "subnet-attachment",
          az_id: "euw1-az1",
          route_table_id: "tgw-table",
          lookup: {
            status: "reported_forward",
            destination_cidr: "0.0.0.0/0",
            route_type: "static",
            attachment_ids: ["egress"],
          },
        },
      },
    };
    await boot(async (path) => {
      if (path.includes("tgw-target-lookup")) {
        calls.push(path);
        return old.promise;
      }
      if (path.includes("tgw-source-lookup")) return response(source);
      return response(vpcTopology(path.includes("account-a") ? "account-a" : "account-b"));
    });
    select("account-a");
    await vi.waitFor(() => expect(document.querySelector("form[data-vpc-route-lookup]")).not.toBeNull());
    const detail = [...document.querySelectorAll<HTMLDetailsElement>("#aws-topology details")].find(
      (node) => node.querySelector("summary")?.textContent === "Inspect saved source-to-TGW candidate",
    );
    if (!detail) throw new Error("Source detail missing");
    detail.open = true;
    detail.dispatchEvent(new Event("toggle"));
    const form = detail.querySelector<HTMLFormElement>("form"),
      network = form?.querySelector("select"),
      input = form?.querySelector("input");
    if (!form || !network || !input) throw new Error("Source controls missing");
    network.value = "account-b";
    input.value = "203.0.113.1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(form.querySelector("fieldset[data-target-entries]")).not.toBeNull());
    const target = form.querySelector<HTMLFieldSetElement>("fieldset[data-target-entries]"),
      choice = target?.querySelector("select");
    if (!target || !choice) throw new Error("Target controls missing");
    choice.value = "egress";
    target.querySelector("button")?.click();
    expect(calls).toEqual([
      "/api/v1/aws/accounts/account-b/tgw-target-lookup?transit_gateway_id=tgw-target&target_attachment_id=egress&destination=203.0.113.1",
    ]);
    if (change === "account switch") {
      select("account-b");
      await vi.waitFor(() =>
        expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-b"),
      );
    } else document.querySelector<HTMLButtonElement>("#logout")?.click();
    const result: TgwTargetResponse = {
      topology_id: "snapshot-account-b",
      completed_at: "4",
      transit_gateway_id: "tgw-target",
      target_attachment_id: "egress",
      destination: "203.0.113.1",
      az_selection: "not_inferred",
      execution_enabled: false,
      connectivity_tested: false,
      result: {
        status: "reported_subnets",
        vpc_id: "vpc-target",
        subnets: [
          {
            subnet_id: "subnet-late-target",
            az_id: "euw1-az1",
            lookup: { status: "unresolved", reason: "scope_not_ready" },
          },
        ],
      },
    };
    old.resolve(response(result));
    await vi.waitFor(() => expect(target.querySelector("button")?.disabled).toBe(false));
    expect(document.querySelector("#aws-topology")?.textContent).not.toContain("subnet-late-target");
    expect(target.textContent).not.toContain("subnet-late-target");
    target.querySelector("button")?.click();
    await new Promise((done) => setTimeout(done, 10));
    expect(calls).toHaveLength(1);
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it("late account topology cannot replace a newer selected account", async () => {
  const old = deferred();
  await boot(async (path) => (path.includes("account-a") ? old.promise : response(topology("account-b"))));
  select("account-a");
  select("account-b");
  await vi.waitFor(() =>
    expect(document.querySelector("#aws-topology")?.textContent).toContain("table-account-b"),
  );
  old.resolve(response(topology("account-a")));
  await new Promise((done) => setTimeout(done, 10));
  expect(document.querySelector("#aws-topology")?.textContent).toContain("table-account-b");
  expect(document.querySelector("#aws-topology")?.textContent).not.toContain("table-account-a");
});
it("late saved lookup cannot enter another account view", async () => {
  const old = deferred();
  await boot(async (path) =>
    path.includes("tgw-route-lookup")
      ? old.promise
      : response(topology(path.includes("account-a") ? "account-a" : "account-b")),
  );
  select("account-a");
  await vi.waitFor(() => expect(document.querySelector("form[data-route-lookup]")).not.toBeNull());
  startLookup();
  select("account-b");
  await vi.waitFor(() =>
    expect(document.querySelector("#aws-topology")?.textContent).toContain("table-account-b"),
  );
  old.resolve(response(lookup));
  await new Promise((done) => setTimeout(done, 10));
  expect(document.querySelector("#aws-topology")?.textContent).not.toContain("old-lookup-attachment");
});
it("logout clears saved lookup and discards its response even when fetch ignores abort", async () => {
  const old = deferred();
  await boot(async (path) =>
    path.includes("tgw-route-lookup") ? old.promise : response(topology("account-a")),
  );
  select("account-a");
  await vi.waitFor(() => expect(document.querySelector("form[data-route-lookup]")).not.toBeNull());
  startLookup();
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  old.resolve(response(lookup));
  await new Promise((done) => setTimeout(done, 10));
  expect(document.querySelector("#aws-topology")?.childElementCount).toBe(0);
  expect(document.querySelector("#identity")?.textContent).toBe("Signed out");
  expect(document.querySelector<HTMLElement>("#workspace")?.hidden).toBe(true);
});

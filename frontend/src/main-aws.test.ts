import { afterEach, expect, it, vi } from "vitest";
import type {
  NatReferenceResponse,
  Snapshot,
  SourceHandoffCidrCoverage,
  TgwLookupResponse,
  TgwSourceResponse,
  TgwTargetResponse,
  TopologyView,
  VerifiedAccount,
  VpcCidrCoverageResponse,
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
function natReply(): NatReferenceResponse {
  const resource = topology("account-a").topology.resources[0];
  if (!resource) throw new Error("Missing fixture");
  return {
    account_id: "account-a",
    topology_id: "snapshot-account-a",
    completed_at: "2",
    subnet_id: "subnet-account-a",
    destination: "203.0.113.1",
    reference_only: true,
    execution_enabled: false,
    connectivity_tested: false,
    result: {
      subnet_lookup: {
        status: "reported",
        route_table_id: "rtb-account-a",
        source: "implicit_main",
        lookup: {
          status: "reported_route",
          destination_cidr: "0.0.0.0/0",
          origin: "CreateRoute",
          target: { kind: "nat_gateway", id: "nat-reference-old" },
        },
      },
      reference: {
        status: "reported_record",
        owner_scope: "not_reported",
        vpc_scope: "not_reported",
        resource: { ...resource, kind: "nat_gateway", id: "nat-reference-old" },
      },
    },
  };
}
async function startNatReference() {
  select("account-a");
  await vi.waitFor(() => expect(document.querySelector("form[data-vpc-route-lookup]")).not.toBeNull());
  const form = document.querySelector<HTMLFormElement>("form[data-vpc-route-lookup]");
  const input = form?.querySelector<HTMLInputElement>("input");
  if (!form || !input) throw new Error("Missing parent form");
  input.value = "203.0.113.1";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(form.querySelector("fieldset[data-nat-reference]")).not.toBeNull());
  const panel = form.querySelector<HTMLFieldSetElement>("fieldset[data-nat-reference]");
  const action = panel?.querySelector<HTMLButtonElement>("button");
  if (!panel || !action) throw new Error("Missing NAT control");
  action.click();
  return { form, panel, action };
}
function natVpcResponse() {
  const nat = natReply();
  return {
    topology_id: nat.topology_id,
    subnet_id: nat.subnet_id,
    destination: nat.destination,
    result: nat.result.subnet_lookup,
    execution_enabled: false,
    connectivity_tested: false,
  };
}
it("retires completed NAT evidence immediately while an authorized discovery refresh is pending", async () => {
  // Deferred fetch fixture only: no SDK, server, credentials or cloud request.
  const discovery = deferred();
  let calls = 0;
  await boot(
    async (path) => {
      if (path.endsWith("/discover")) return discovery.promise;
      if (path.includes("nat-reference-lookup")) {
        calls++;
        return response(natReply());
      }
      if (path.includes("vpc-route-lookup")) return response(natVpcResponse());
      return response(vpcTopology("account-a"));
    },
    { ...snapshot, role: "admin", aws_read_only_enabled: true },
  );
  const old = await startNatReference();
  await vi.waitFor(() => expect(old.panel.textContent).toContain("Referenced saved NAT record:"));
  const row = [...document.querySelectorAll("#aws-account-list li")].find((node) =>
    node.textContent?.includes("Fixture account-a"),
  );
  const refresh = row?.querySelectorAll<HTMLButtonElement>("button")[1];
  if (!refresh) throw new Error("Missing discovery refresh");
  refresh.click();
  expect(document.querySelector("#aws-topology")?.childElementCount).toBe(0);
  old.action.click();
  old.form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(calls).toBe(1);
  discovery.resolve(response({}));
  await vi.waitFor(() =>
    expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-a"),
  );
});
it("retires completed NAT evidence immediately while replacement account topology is pending", async () => {
  const replacement = deferred();
  const calls: string[] = [];
  await boot(async (path) => {
    if (path.includes("nat-reference-lookup")) {
      calls.push(path);
      return response(natReply());
    }
    if (path.includes("vpc-route-lookup")) return response(natVpcResponse());
    if (path.includes("account-b")) return replacement.promise;
    return response(vpcTopology("account-a"));
  });
  const old = await startNatReference();
  await vi.waitFor(() => expect(old.panel.textContent).toContain("Referenced saved NAT record:"));
  select("account-b");
  expect(document.querySelector("#aws-topology")?.childElementCount).toBe(0);
  old.action.click();
  old.form.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(calls).toHaveLength(1);
  replacement.resolve(response(vpcTopology("account-b")));
  await vi.waitFor(() =>
    expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-b"),
  );
});
it("fences pending NAT reads and retained parent/child/lazy handlers across account ABA, reload and logout", async () => {
  for (const retirement of ["switch", "ABA", "reload", "logout"])
    for (const failed of [false, true]) {
      const pending = deferred();
      const calls: string[] = [];
      await boot(async (path) => {
        if (path.includes("nat-reference-lookup")) {
          calls.push(path);
          return pending.promise;
        }
        if (path.includes("vpc-route-lookup")) return response(natVpcResponse());
        return response(vpcTopology(path.includes("account-a") ? "account-a" : "account-b"));
      });
      const old = await startNatReference();
      expect(calls).toEqual([
        "/api/v1/aws/accounts/account-a/nat-reference-lookup?subnet_id=subnet-account-a&destination=203.0.113.1",
      ]);
      if (retirement === "logout") document.querySelector<HTMLButtonElement>("#logout")?.click();
      else {
        select(retirement === "reload" ? "account-a" : "account-b");
        await vi.waitFor(() =>
          expect(document.querySelector("#aws-topology")?.textContent).toContain(
            retirement === "reload" ? "subnet-account-a" : "subnet-account-b",
          ),
        );
        if (retirement === "ABA") {
          select("account-a");
          await vi.waitFor(() =>
            expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-a"),
          );
        }
      }
      old.action.disabled = false;
      old.action.click();
      old.form.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(calls).toHaveLength(1);
      pending.resolve(
        failed
          ? new Response(JSON.stringify({ error: "obsolete failure" }), { status: 500 })
          : response(natReply()),
      );
      await new Promise((done) => setTimeout(done, 0));
      expect(old.panel.querySelector("details")).toBeNull();
      expect(document.querySelector("#aws-topology")?.textContent).not.toContain("nat-reference-old");
      expect(document.querySelector("#aws-topology")?.textContent).not.toContain("obsolete failure");
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    }
});
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
          nat_gateway: null,
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
async function boot(handler: (path: string) => Promise<Response>, state: Snapshot = snapshot) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      return path === "/api/v1/snapshot" ? Promise.resolve(response(state)) : handler(path);
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
it("navigation retires an ignored-abort audit response across an away/back cycle", async () => {
  const old = deferred();
  await boot(async () => old.promise);
  const go = (route: string) => {
    window.location.hash = `#/${route}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  go("diagnostics");
  document.querySelector<HTMLButtonElement>("#audit")?.click();
  go("operations");
  go("diagnostics");
  old.resolve(response({ retired_audit: "old route evidence" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector("#diagnostic-output")?.textContent).toBe("");
  expect(document.querySelector("#notice")?.textContent).toBe("");
});

it("CIDR reads use exact account/query bindings and retire on switch, ABA, reload, login and discovery despite ignored abort", async () => {
  for (const retirement of ["switch", "ABA", "reload", "logout", "login", "discovery"])
    for (const failed of [false, true]) {
      const old = deferred(),
        discovery = deferred(),
        paths: string[] = [];
      await boot(
        async (path) => {
          if (path.endsWith("/discover")) return discovery.promise;
          if (path.includes("vpc-cidr-coverage?")) {
            paths.push(path);
            return old.promise;
          }
          return response(vpcTopology(path.includes("account-a") ? "account-a" : "account-b"));
        },
        retirement === "discovery" ? { ...snapshot, role: "admin", aws_read_only_enabled: true } : snapshot,
      );
      select("account-a");
      await vi.waitFor(() =>
        expect(document.querySelector("details[data-vpc-cidr-inspector]")).not.toBeNull(),
      );
      const detail = document.querySelector<HTMLDetailsElement>("details[data-vpc-cidr-inspector]");
      if (!detail) throw new Error("Missing CIDR detail");
      detail.open = true;
      detail.dispatchEvent(new Event("toggle"));
      const input = detail.querySelector("input"),
        action = detail.querySelector("button"),
        status = detail.querySelector("[role=status]");
      if (!input || !action || !status) throw new Error("Missing CIDR controls");
      input.value = "10.0.0.0/16";
      action.click();
      action.click();
      expect(paths).toEqual([
        "/api/v1/aws/accounts/account-a/vpc-cidr-coverage?subnet_id=subnet-account-a&destination_cidr=10.0.0.0%2F16",
      ]);
      if (retirement === "switch" || retirement === "ABA") {
        select("account-b");
        await vi.waitFor(() =>
          expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-b"),
        );
      }
      if (retirement === "ABA" || retirement === "reload") {
        select("account-a");
        await vi.waitFor(() =>
          expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-a"),
        );
      }
      if (retirement === "logout" || retirement === "login")
        document.querySelector<HTMLButtonElement>("#logout")?.click();
      if (retirement === "login") {
        const token = document.querySelector<HTMLInputElement>("#token");
        if (!token) throw new Error("Missing token");
        token.value = "fixture-reader";
        document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
        await vi.waitFor(() => expect(document.querySelectorAll("#aws-account-list li")).toHaveLength(2));
        select("account-a");
        await vi.waitFor(() =>
          expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-a"),
        );
      }
      if (retirement === "discovery") {
        const row = [...document.querySelectorAll("#aws-account-list li")].find((node) =>
          node.textContent?.includes("Fixture account-a"),
        );
        const refresh = row?.querySelectorAll<HTMLButtonElement>("button")[1];
        if (!refresh) throw new Error("Missing refresh");
        refresh.click();
        expect(document.querySelector("#aws-topology")?.childElementCount).toBe(0);
      }
      const before = status.textContent;
      const body: VpcCidrCoverageResponse = {
        account_id: "account-a",
        topology_id: "snapshot-account-a",
        completed_at: "2",
        aws_account_id: "123456789012",
        region: "eu-west-1",
        subnet_id: "subnet-account-a",
        destination_cidr: "10.0.0.0/16",
        complete_for_supported_queries: true,
        limitations: [],
        request_ids: [],
        reference_only: true,
        execution_enabled: false,
        connectivity_tested: false,
        coverage: {
          destination_cidr: "10.0.0.0/16",
          partition_complete: true,
          table_evidence: null,
          segments: [
            {
              start: "10.0.0.0",
              end_inclusive: "10.0.255.255",
              result: { status: "unresolved", reason: "scope_not_ready" },
            },
          ],
        },
      };
      old.resolve(
        failed
          ? new Response(JSON.stringify({ error: "late CIDR failure" }), { status: 409 })
          : response(body),
      );
      await new Promise((done) => setTimeout(done, 10));
      expect(status.textContent).toBe(before);
      expect(detail.querySelectorAll("[data-vpc-cidr-interval]")).toHaveLength(0);
      action.click();
      detail.dispatchEvent(new Event("toggle"));
      expect(paths).toHaveLength(1);
      expect(document.querySelector("#aws-topology")?.textContent).not.toContain("late CIDR failure");
      if (retirement === "discovery") {
        discovery.resolve(response({}));
        await vi.waitFor(() =>
          expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-a"),
        );
      }
    }
}, 15000);
it("attachment point requests use A under a B candidate and outer generations fence ignored-abort success/error", async () => {
  for (const retirement of ["switch", "ABA", "reload", "logout"])
    for (const failed of [false, true]) {
      const pending = deferred(),
        paths: string[] = [];
      const point: VpcLookupResponse = {
        topology_id: "snapshot-account-a",
        subnet_id: "subnet-attachment",
        destination: "10.10.254.10",
        execution_enabled: false,
        connectivity_tested: false,
        result: {
          status: "reported",
          route_table_id: "rtb-attachment",
          source: "explicit_subnet",
          lookup: {
            status: "reported_route",
            destination_cidr: "10.10.0.0/16",
            origin: "CreateRouteTable",
            target: { kind: "local" },
          },
        },
      };
      const source: TgwSourceResponse = {
        source_topology_id: point.topology_id,
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
              target: { kind: "transit_gateway", id: "tgw-cross" },
            },
          },
          handoff: {
            status: "reported_candidate",
            transit_gateway_id: "tgw-cross",
            ingress_attachment_id: "ingress",
            attachment_subnet_id: point.subnet_id,
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
        paths.push(path);
        if (path.includes("vpc-route-lookup")) return pending.promise;
        if (path.includes("tgw-source-lookup")) return response(source);
        const view = vpcTopology(path.includes("account-a") ? "account-a" : "account-b");
        view.subnet_route_tables.push({
          subnet_id: point.subnet_id,
          vpc_id: "vpc-account-a",
          selection: { status: "selected", route_table_id: "rtb-attachment", source: "explicit_subnet" },
        });
        return response(view);
      });
      select("account-a");
      await vi.waitFor(() => expect(document.querySelector("form[data-vpc-route-lookup]")).not.toBeNull());
      const detail = [...document.querySelectorAll<HTMLDetailsElement>("#aws-topology details")].find(
        (node) => node.querySelector("summary")?.textContent === "Inspect saved source-to-TGW candidate",
      );
      if (!detail) throw new Error("Missing source detail");
      detail.open = true;
      detail.dispatchEvent(new Event("toggle"));
      const form = detail.querySelector("form"),
        network = form?.querySelector("select"),
        destination = form?.querySelector("input");
      if (!form || !network || !destination) throw new Error("Missing controls");
      network.value = "account-b";
      destination.value = source.destination;
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.waitFor(() =>
        expect(form.querySelector("fieldset[data-source-attachment-entry]")).not.toBeNull(),
      );
      const child = form.querySelector("fieldset[data-source-attachment-entry]"),
        input = child?.querySelector("input"),
        action = child?.querySelector("button");
      if (!child || !input || !action) throw new Error("Missing child");
      expect(paths.filter((path) => path.includes("vpc-route-lookup"))).toHaveLength(0);
      input.value = point.destination;
      action.click();
      expect(paths.filter((path) => path.includes("vpc-route-lookup"))).toEqual([
        "/api/v1/aws/accounts/account-a/vpc-route-lookup?subnet_id=subnet-attachment&destination=10.10.254.10",
      ]);
      if (retirement === "logout") document.querySelector<HTMLButtonElement>("#logout")?.click();
      else {
        select(retirement === "reload" ? "account-a" : "account-b");
        await vi.waitFor(() =>
          expect(document.querySelector("#aws-topology")?.textContent).toContain(
            retirement === "reload" ? "subnet-account-a" : "subnet-account-b",
          ),
        );
        if (retirement === "ABA") {
          select("account-a");
          await vi.waitFor(() =>
            expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-a"),
          );
        }
      }
      action.disabled = false;
      action.click();
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(paths.filter((path) => path.includes("vpc-route-lookup"))).toHaveLength(1);
      pending.resolve(
        failed
          ? new Response(JSON.stringify({ error: "obsolete point failure" }), { status: 500 })
          : response(point),
      );
      await new Promise((done) => setTimeout(done, 0));
      expect(document.querySelector("#aws-topology")?.textContent).not.toContain(
        "Reported attachment-subnet entry",
      );
      expect(document.querySelector("#aws-topology")?.textContent).not.toContain("obsolete point failure");
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    }
}, 15_000);
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
it("cross-account NAT requests stay bound to B under A and retire across parent and view generations despite ignored abort", async () => {
  for (const retirement of [
    "switch",
    "ABA",
    "reload",
    "logout",
    "source resubmit",
    "source change",
    "network ABA",
    "target resubmit",
    "attachment input",
  ])
    for (const failed of [false, true]) {
      const old = deferred(),
        paths: string[] = [];
      const nat = natReply();
      nat.account_id = "account-b";
      nat.topology_id = "snapshot-account-b";
      nat.completed_at = "4";
      nat.subnet_id = "subnet-target";
      if (nat.result.reference.status !== "reported_record") throw new Error("Bad fixture");
      nat.result.reference.resource.owner_account_id = "210987654321";
      nat.result.reference.owner_scope = "reported_same";
      const sourceEntry = structuredClone(nat.result.subnet_lookup);
      if (sourceEntry.status !== "reported" || sourceEntry.lookup.status !== "reported_route")
        throw new Error("Bad entry");
      sourceEntry.lookup.target = { kind: "transit_gateway", id: "tgw-cross" };
      const source: TgwSourceResponse = {
        source_topology_id: "snapshot-account-a",
        network_topology_id: nat.topology_id,
        source_completed_at: "2",
        network_completed_at: "4",
        network_account_id: "account-b",
        subnet_id: "subnet-account-a",
        destination: nat.destination,
        execution_enabled: false,
        connectivity_tested: false,
        result: {
          source: sourceEntry,
          handoff: {
            status: "reported_candidate",
            transit_gateway_id: "tgw-cross",
            ingress_attachment_id: "ingress",
            attachment_subnet_id: "attachment-subnet",
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
      const target: TgwTargetResponse = {
        topology_id: nat.topology_id,
        completed_at: "4",
        transit_gateway_id: "tgw-cross",
        target_attachment_id: "egress",
        destination: nat.destination,
        az_selection: "not_inferred",
        execution_enabled: false,
        connectivity_tested: false,
        result: {
          status: "reported_subnets",
          vpc_id: "vpc-target",
          subnets: [{ subnet_id: nat.subnet_id, az_id: "euw1-az1", lookup: nat.result.subnet_lookup }],
        },
      };
      await boot(
        async (path) => {
          paths.push(path);
          if (path.includes("nat-reference-lookup")) return old.promise;
          if (path.includes("tgw-source-lookup")) return response(source);
          if (path.includes("tgw-target-lookup")) return response(target);
          const view = vpcTopology(path.includes("account-a") ? "account-a" : "account-b");
          if (view.topology.account_id === "account-b") {
            view.topology.aws_account_id = "210987654321";
            view.topology.completed_at = "4";
          }
          return response(view);
        },
        {
          ...snapshot,
          aws_accounts: [account("account-a"), { ...account("account-b"), aws_account_id: "210987654321" }],
        },
      );
      select("account-a");
      await vi.waitFor(() => expect(document.querySelector("form[data-vpc-route-lookup]")).not.toBeNull());
      const detail = [...document.querySelectorAll<HTMLDetailsElement>("#aws-topology details")].find(
        (node) => node.querySelector("summary")?.textContent === "Inspect saved source-to-TGW candidate",
      );
      if (!detail) throw new Error("Missing source detail");
      detail.open = true;
      detail.dispatchEvent(new Event("toggle"));
      const form = detail.querySelector<HTMLFormElement>("form"),
        network = form?.querySelector("select"),
        destination = form?.querySelector("input");
      if (!form || !network || !destination) throw new Error("Missing source controls");
      network.value = "account-b";
      destination.value = nat.destination;
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.waitFor(() => expect(form.querySelector("fieldset[data-target-entries]")).not.toBeNull());
      const panel = form.querySelector<HTMLFieldSetElement>("fieldset[data-target-entries]"),
        attachment = panel?.querySelector("select"),
        targetButton = panel?.querySelector("button");
      if (!panel || !attachment || !targetButton) throw new Error("Missing target controls");
      attachment.value = "egress";
      targetButton.click();
      await vi.waitFor(() => expect(panel.querySelector("fieldset[data-nat-reference]")).not.toBeNull());
      const child = panel.querySelector<HTMLFieldSetElement>("fieldset[data-nat-reference]"),
        action = child?.querySelector("button");
      if (!child || !action) throw new Error("Missing child");
      expect(paths.filter((path) => path.includes("nat-reference-lookup"))).toHaveLength(0);
      action.click();
      expect(paths.filter((path) => path.includes("nat-reference-lookup"))).toEqual([
        "/api/v1/aws/accounts/account-b/nat-reference-lookup?subnet_id=subnet-target&destination=203.0.113.1",
      ]);
      expect(paths.some((path) => path.includes("account-a/tgw-source-lookup"))).toBe(true);
      expect(paths.some((path) => path.includes("account-b/tgw-target-lookup"))).toBe(true);
      if (retirement === "logout") document.querySelector<HTMLButtonElement>("#logout")?.click();
      else if (retirement === "switch" || retirement === "ABA" || retirement === "reload") {
        select(retirement === "reload" ? "account-a" : "account-b");
        await vi.waitFor(() =>
          expect(document.querySelector("#aws-topology")?.textContent).toContain(
            retirement === "reload" ? "subnet-account-a" : "subnet-account-b",
          ),
        );
        if (retirement === "ABA") {
          select("account-a");
          await vi.waitFor(() =>
            expect(document.querySelector("#aws-topology")?.textContent).toContain("subnet-account-a"),
          );
        }
      } else if (retirement === "source resubmit")
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      else if (retirement === "source change") {
        destination.value = "203.0.113.2";
        destination.dispatchEvent(new Event("change"));
      } else if (retirement === "network ABA") {
        network.value = "account-a";
        network.dispatchEvent(new Event("input"));
        network.value = "account-b";
        network.dispatchEvent(new Event("change"));
      } else if (retirement === "target resubmit") targetButton.click();
      else {
        attachment.value = "";
        attachment.dispatchEvent(new Event("input"));
      }
      action.disabled = false;
      action.click();
      expect(paths.filter((path) => path.includes("nat-reference-lookup"))).toHaveLength(1);
      old.resolve(
        failed
          ? new Response(JSON.stringify({ error: "obsolete cross-account failure" }), { status: 500 })
          : response(nat),
      );
      await new Promise((done) => setTimeout(done, 0));
      expect(child.querySelector("details")).toBeNull();
      expect(document.querySelector("#aws-topology")?.textContent).not.toContain(
        "Referenced saved NAT record:",
      );
      expect(document.querySelector("#aws-topology")?.textContent).not.toContain(
        "obsolete cross-account failure",
      );
      if (["switch", "ABA", "reload", "logout"].includes(retirement)) {
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        targetButton.click();
        detail.querySelector("form")?.remove();
        detail.dispatchEvent(new Event("toggle"));
        expect(detail.querySelector("form")).toBeNull();
      }
      expect(paths.filter((path) => path.includes("nat-reference-lookup"))).toHaveLength(1);
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    }
}, 15_000);
function sourceCidrReply(): SourceHandoffCidrCoverage {
  const source = vpcTopology("account-a").topology,
    network = vpcTopology("account-b").topology;
  network.completed_at = "4";
  return {
    query: {
      source_account_id: "account-a",
      network_account_id: "account-b",
      subnet_id: "subnet-account-a",
      destination_cidr: "203.0.113.0/29",
    },
    source_saved: {
      registration: account("account-a"),
      saved_row_id: source.id,
      generation: 1,
      admitted_bytes: 0,
      topology: source,
    },
    network_saved: {
      registration: account("account-b"),
      saved_row_id: network.id,
      generation: 2,
      admitted_bytes: 0,
      topology: network,
    },
    segments: [
      {
        start: "203.0.113.0",
        end_inclusive: "203.0.113.7",
        result: {
          source: { status: "unresolved", reason: "missing_subnet" },
          handoff: { status: "unresolved", reason: "missing_source_scope" },
        },
      },
    ],
    origins: [{ cut_index: 0, predicate: { kind: "query" }, edge: "query_start", clipped: false }],
    reference_only: true,
    partition_complete: true,
    execution_enabled: false,
    connectivity_tested: false,
    simultaneous_snapshots: false,
  };
}
it("source CIDR main integration uses only the selected SOURCE GET and fences accepted retained controls plus late success/error across view/session retirement", async () => {
  for (const retirement of ["switch", "ABA", "reload", "logout", "login", "discovery"])
    for (const failed of [false, true]) {
      const pending = deferred(),
        discovery = deferred(),
        paths: string[] = [];
      let reads = 0;
      await boot(
        async (path) => {
          paths.push(path);
          if (path.endsWith("/discover")) return discovery.promise;
          if (path.includes("tgw-source-cidr-coverage?"))
            return ++reads === 1 ? response(sourceCidrReply()) : pending.promise;
          return response(vpcTopology(path.includes("account-a") ? "account-a" : "account-b"));
        },
        retirement === "discovery" ? { ...snapshot, role: "admin", aws_read_only_enabled: true } : snapshot,
      );
      select("account-a");
      await vi.waitFor(() => expect(document.querySelector("#aws-topology article")).not.toBeNull());
      const parent = required(
        [...document.querySelectorAll<HTMLDetailsElement>("#aws-topology details")].find(
          (d) => d.querySelector(":scope > summary")?.textContent === "Inspect saved source-to-TGW candidate",
        ),
      );
      parent.open = true;
      parent.dispatchEvent(new Event("toggle"));
      const form = required(parent.querySelector("form"));
      required(form.querySelector("select")).value = "account-b";
      const detail = form.querySelector<HTMLDetailsElement>("[data-source-cidr]");
      expect(detail).not.toBeNull();
      if (!detail) throw new Error("Missing CIDR sibling");
      detail.open = true;
      detail.dispatchEvent(new Event("toggle"));
      const input = required(detail.querySelector("input")),
        action = required(detail.querySelector("button"));
      input.value = "203.0.113.0/29";
      action.click();
      await vi.waitFor(() => expect(detail.querySelector("[data-source-cidr-summary]")).not.toBeNull());
      expect(paths).toEqual([
        "/api/v1/aws/accounts/account-a/topology",
        "/api/v1/aws/accounts/account-a/tgw-source-cidr-coverage?network_account_id=account-b&subnet_id=subnet-account-a&destination_cidr=203.0.113.0%2F29",
      ]);
      const retained = required(detail.querySelector<HTMLDetailsElement>("[data-source-cidr-intervals]"));
      action.click();
      expect(reads).toBe(2);
      if (retirement === "switch" || retirement === "ABA") select("account-b");
      if (retirement === "ABA" || retirement === "reload") select("account-a");
      if (retirement === "logout" || retirement === "login")
        required(document.querySelector<HTMLButtonElement>("#logout")).click();
      if (retirement === "login") {
        required(document.querySelector<HTMLInputElement>("#token")).value = "new-fixture-reader";
        required(document.querySelector("#login")).dispatchEvent(new Event("submit", { cancelable: true }));
      }
      if (retirement === "discovery")
        required(
          [...document.querySelectorAll<HTMLButtonElement>("#aws-account-list li:first-child button")][1],
        ).click();
      retained.open = true;
      retained.dispatchEvent(new Event("toggle"));
      expect(retained.querySelector("[data-source-cidr-interval]")).toBeNull();
      action.disabled = false;
      action.click();
      expect(reads).toBe(2);
      pending.resolve(
        failed
          ? new Response(JSON.stringify({ error: "obsolete CIDR failure" }), { status: 500 })
          : response(sourceCidrReply()),
      );
      await new Promise((done) => setTimeout(done, 0));
      expect(detail.querySelector("[data-source-cidr-summary]")).toBeNull();
      expect(required(document.querySelector("#aws-topology")).textContent).not.toContain(
        "obsolete CIDR failure",
      );
      if (retirement === "discovery") {
        discovery.resolve(response({}));
        await new Promise((done) => setTimeout(done, 0));
      }
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    }
}, 15_000);
function consentTopology(id: string, generation: number): TopologyView {
  const view = topology(id);
  view.topology.id = `consent-${id}-${generation}`;
  const row = required(view.topology.resources[0]);
  row.kind = "vpc";
  row.id = `vpc-${id}`;
  row.owner_account_id = view.topology.aws_account_id;
  return view;
}
it("old metadata consent completion cannot reload a newer same-account saved view", async () => {
  // Deferred fetch only: no real SDK, credential, server or database write.
  for (const retirement of ["reload", "ABA"]) {
    const pending = deferred();
    let reads = 0,
      writes = 0;
    await boot(
      async (path) => {
        if (path.endsWith("/adoptions")) {
          writes++;
          return pending.promise;
        }
        return response(consentTopology(path.includes("account-b") ? "account-b" : "account-a", ++reads));
      },
      { ...snapshot, role: "admin", aws_read_only_enabled: true },
    );
    select("account-a");
    await vi.waitFor(() => expect(document.querySelector("#aws-topology form")).not.toBeNull());
    const oldForm = required(document.querySelector<HTMLFormElement>("#aws-topology form"));
    required(oldForm.querySelector("input")).value = "Original capture consent";
    oldForm.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(writes).toBe(1);
    if (retirement === "ABA") {
      select("account-b");
      await vi.waitFor(() =>
        expect(document.querySelector("[data-topology-id]")?.getAttribute("data-topology-id")).toBe(
          "consent-account-b-2",
        ),
      );
    }
    select("account-a");
    const expectedReads = retirement === "ABA" ? 3 : 2;
    await vi.waitFor(() =>
      expect(document.querySelector("[data-topology-id]")?.getAttribute("data-topology-id")).toBe(
        `consent-account-a-${expectedReads}`,
      ),
    );
    expect(reads).toBe(expectedReads);
    pending.resolve(response({}));
    await new Promise((done) => setTimeout(done, 0));
    expect(reads).toBe(expectedReads);
    expect(writes).toBe(1);
    expect(document.querySelector("[data-topology-id]")?.getAttribute("data-topology-id")).toBe(
      `consent-account-a-${expectedReads}`,
    );
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  }
});
it("current metadata consent keeps its exact payload and reloads its selected saved capture", async () => {
  let reads = 0;
  await boot(
    async (path) =>
      path.endsWith("/adoptions") ? response({}) : response(consentTopology("account-a", ++reads)),
    { ...snapshot, role: "admin", aws_read_only_enabled: true },
  );
  select("account-a");
  await vi.waitFor(() => expect(document.querySelector("#aws-topology form")).not.toBeNull());
  const form = required(document.querySelector<HTMLFormElement>("#aws-topology form"));
  required(form.querySelector("input")).value = "  Keep literal consent reason  ";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector("[data-topology-id]")?.getAttribute("data-topology-id")).toBe(
      "consent-account-a-2",
    ),
  );
  const calls = vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith("/adoptions"));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("/api/v1/aws/accounts/account-a/adoptions");
  expect(calls[0]?.[1]?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
    topology_id: "consent-account-a-1",
    resource_kind: "vpc",
    resource_id: "vpc-account-a",
    reason: "  Keep literal consent reason  ",
  });
  expect(reads).toBe(2);
});
it("current metadata consent permission getter blocks retained programmatic submits after role or SDK downgrade", async () => {
  // GREEN qualification of the existing getter, not another claimed product defect.
  for (const change of ["role", "SDK"]) {
    const state: Snapshot = { ...snapshot, role: "admin", aws_read_only_enabled: true };
    let writes = 0;
    await boot(async (path) => {
      if (path.endsWith("/adoptions")) writes++;
      return response(consentTopology("account-a", 1));
    }, state);
    select("account-a");
    await vi.waitFor(() => expect(document.querySelector("#aws-topology form")).not.toBeNull());
    const form = required(document.querySelector<HTMLFormElement>("#aws-topology form")),
      button = required(form.querySelector("button"));
    required(form.querySelector("input")).value = "Do not dispatch after downgrade";
    if (change === "role") state.role = "read_only";
    else state.aws_read_only_enabled = false;
    required(document.querySelector<HTMLButtonElement>("#refresh")).click();
    await vi.waitFor(() => expect(button.disabled).toBe(true));
    button.disabled = false;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(writes).toBe(0);
    expect(form.textContent).toContain("Metadata consent is no longer enabled");
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  }
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

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test fixture/control");
  return value;
}

function handoffState(): Snapshot {
  const data = structuredClone(snapshot);
  data.role = "admin";
  data.accounts = ["a", "b"].map((id) => ({
    id,
    name: id,
    provider: "fake",
    role_arn: "fake:fixture",
    revision: 1,
  }));
  data.inventory = ["a", "b"].map((id) => ({
    account_id: id,
    vpc_id: `vpc-${id}`,
    region: "eu-west-1",
    cidr: "10.10.0.0/16",
    revision: 1,
    subnets: [{ id: `subnet-${id}`, az_id: "az-1", route_table: `rtb-${id}`, default_route_managed: true }],
  }));
  data.networks = ["a", "b"].map((id) => ({
    id: `net-${id}`,
    name: id,
    region: "eu-west-1",
    revision: 1,
    egress_cidr: "10.250.0.0/16",
    az_ids: ["az-1"],
    public_ips: [],
    application_cidrs: [],
    managed_nat: true,
  }));
  return data;
}
function handoffChoice(id: string, value: string) {
  const control = required(document.querySelector<HTMLSelectElement>(`#${id}`));
  control.value = value;
  control.dispatchEvent(new Event("change"));
}
function handoffButton() {
  return required(
    [...document.querySelectorAll<HTMLButtonElement>("#network-list button")].find(
      (b) => b.textContent === "Configure selected VPC",
    ),
  );
}
it("main hands the current selected map VPC and network into existing configuration without a request", async () => {
  window.history.replaceState(null, "", "/#/networks");
  await boot(async () => {
    throw new Error("Unexpected handoff request");
  }, handoffState());
  handoffChoice("workspace-vpc", JSON.stringify(["b", "vpc-b"]));
  handoffChoice("workspace-network", "net-b");
  handoffChoice("workspace-vpc", JSON.stringify(["b", "vpc-b"]));
  handoffChoice("vpc", "vpc-a");
  handoffChoice("network", "net-a");
  const old = handoffButton(),
    calls = vi.mocked(fetch).mock.calls.length;
  old.click();
  expect(window.location.hash).toBe("#/connections");
  expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(false);
  expect(required(document.querySelector<HTMLSelectElement>("#vpc")).value).toBe("vpc-b");
  expect(required(document.querySelector<HTMLSelectElement>("#network")).value).toBe("net-b");
  expect(
    [...document.querySelectorAll<HTMLInputElement>("#subnets input:checked")].map((n) => n.value),
  ).toEqual(["subnet-b"]);
  expect(document.querySelector("#connection-step")?.textContent).toContain("vpc-b");
  window.location.hash = "#/networks";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  handoffChoice("workspace-vpc", JSON.stringify(["a", "vpc-a"]));
  old.click();
  expect(window.location.hash).toBe("#/networks");
  expect(required(document.querySelector<HTMLSelectElement>("#vpc")).value).toBe("vpc-b");
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
});
it("main refuses ambiguous or missing form identities and read-only map handoff before changing the form", async () => {
  for (const variant of ["duplicate-vpc", "missing-option", "read-only"]) {
    const data = handoffState();
    if (variant === "duplicate-vpc") data.inventory[1].vpc_id = data.inventory[0].vpc_id;
    if (variant === "read-only") data.role = "read_only";
    window.history.replaceState(null, "", "/#/networks");
    await boot(async () => {
      throw new Error("Unexpected handoff request");
    }, data);
    if (variant === "missing-option") required(document.querySelector("#vpc option")).remove();
    const form = required(document.querySelector("#plan-form")),
      before = form.innerHTML,
      calls = vi.mocked(fetch).mock.calls.length;
    const action = handoffButton();
    if (variant === "read-only") expect(action.disabled).toBe(true);
    action.disabled = false;
    action.click();
    expect(window.location.hash).toBe("#/networks");
    expect(form.innerHTML).toBe(before);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    if (variant !== "read-only")
      expect(document.querySelector("#notice")?.textContent).toContain("cannot be represented uniquely");
  }
});

it("manual VPC selection never displays or configures the first ambiguous inventory row", async () => {
  for (const identical of [false, true])
    for (const reverse of [false, true]) {
      const data = handoffState();
      data.inventory[1] = identical
        ? structuredClone(data.inventory[0])
        : { ...data.inventory[1], vpc_id: data.inventory[0].vpc_id };
      data.accounts.push({ ...data.accounts[0], id: "unique-account" });
      data.inventory.push({
        ...data.inventory[0],
        account_id: "unique-account",
        vpc_id: "vpc-unique",
        subnets: [{ ...data.inventory[0].subnets[0], id: "subnet-unique" }],
      });
      if (reverse) data.inventory.reverse();
      window.history.replaceState(null, "", "/#/connections");
      await boot(async () => {
        throw new Error("Ambiguous selection must not send a request");
      }, data);
      const vpc = required(document.querySelector<HTMLSelectElement>("#vpc"));
      vpc.selectedIndex = 1;
      vpc.dispatchEvent(new Event("change"));
      expect(document.querySelectorAll("#subnets input")).toHaveLength(0);
      const calls = vi.mocked(fetch).mock.calls.length;
      required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
      await vi.waitFor(() =>
        expect(document.querySelector("#notice")?.textContent).toContain("unavailable or ambiguous"),
      );
      expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(true);
      required(document.querySelector("#plan-form")).dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.waitFor(() =>
        expect(document.querySelector("#notice")?.textContent).toContain("unavailable or ambiguous"),
      );
      expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
      handoffChoice("vpc", "vpc-unique");
      required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
      await vi.waitFor(() =>
        expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(false),
      );
      expect([...document.querySelectorAll<HTMLInputElement>("#subnets input")].map((n) => n.value)).toEqual([
        "subnet-unique",
      ]);
      expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    }
});

it("manual plan submit rechecks uniqueness after refresh and recovers only for a unique selected VPC", async () => {
  const data = handoffState();
  window.history.replaceState(null, "", "/#/connections");
  await boot(async () => {
    throw new Error("No plan request may escape an ambiguous selection");
  }, data);
  handoffChoice("vpc", "vpc-a");
  required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
  await vi.waitFor(() =>
    expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(false),
  );
  expect([...document.querySelectorAll<HTMLInputElement>("#subnets input")].map((n) => n.value)).toEqual([
    "subnet-a",
  ]);
  data.inventory[1].vpc_id = "vpc-a";
  required(document.querySelector<HTMLButtonElement>("#refresh")).click();
  await vi.waitFor(() => expect(document.querySelectorAll("#subnets input")).toHaveLength(0));
  const calls = vi.mocked(fetch).mock.calls.length;
  required(document.querySelector("#plan-form")).dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector("#notice")?.textContent).toContain("unavailable or ambiguous"),
  );
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  data.inventory[1].vpc_id = "vpc-b";
  required(document.querySelector<HTMLButtonElement>("#refresh")).click();
  await vi.waitFor(() => expect(document.querySelectorAll("#subnets input")).toHaveLength(1));
  const recoveredCalls = vi.mocked(fetch).mock.calls.length;
  required(document.querySelector<HTMLButtonElement>("#connection-back")).click();
  handoffChoice("vpc", "vpc-b");
  required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
  await vi.waitFor(() => expect(document.querySelector("#connection-step")?.textContent).toContain("vpc-b"));
  expect([...document.querySelectorAll<HTMLInputElement>("#subnets input")].map((n) => n.value)).toEqual([
    "subnet-b",
  ]);
  expect(vi.mocked(fetch).mock.calls.length).toBe(recoveredCalls);
  required(document.querySelector<HTMLButtonElement>("#connection-back")).click();
  const vpc = required(document.querySelector<HTMLSelectElement>("#vpc"));
  vpc.selectedIndex = -1;
  vpc.dispatchEvent(new Event("change"));
  required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
  await vi.waitFor(() =>
    expect(document.querySelector("#notice")?.textContent).toContain("unavailable or ambiguous"),
  );
  expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(true);
  expect(document.querySelectorAll("#subnets input")).toHaveLength(0);
  expect(vi.mocked(fetch).mock.calls.length).toBe(recoveredCalls);
});

function pendingPlanFixture(data: Snapshot): Snapshot["plans"][number] {
  const inventory = data.inventory[0],
    network = data.networks[0];
  return {
    id: "deferred-client-plan",
    scope: `${inventory.account_id}:${inventory.vpc_id}`,
    scope_version: 0,
    inventory_revision: inventory.revision,
    network_revision: network.revision,
    digest: "f".repeat(64),
    request: {
      account_id: inventory.account_id,
      vpc_id: inventory.vpc_id,
      subnet_ids: inventory.subnets.map((s) => s.id),
      network_id: network.id,
      allow_application_traffic: false,
    },
    actions: [
      {
        kind: "attachment",
        target: inventory.vpc_id,
        requires: [],
        postcondition: "Client fixture attachment prerequisite",
      },
    ],
  };
}
it("connection edits retire a pending plan response instead of redirecting to its old scope", async () => {
  const data = handoffState(),
    pending = deferred(),
    plan = pendingPlanFixture(data);
  window.history.replaceState(null, "", "/#/connections");
  await boot(async (path) => {
    if (path === "/api/v1/plans") return pending.promise;
    throw new Error(`Unexpected client fixture request ${path}`);
  }, data);
  handoffChoice("vpc", "vpc-a");
  required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
  await vi.waitFor(() =>
    expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(false),
  );
  required(document.querySelector("#plan-form")).dispatchEvent(new Event("submit", { cancelable: true }));
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.method).toBe("POST");
  const calls = vi.mocked(fetch).mock.calls.length;
  required(document.querySelector<HTMLButtonElement>("#connection-back")).click();
  handoffChoice("vpc", "vpc-b");
  data.plans = [plan];
  const late = response(plan);
  pending.resolve(late);
  await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
  await new Promise((done) => setTimeout(done, 0));
  expect(window.location.hash).toBe("#/connections");
  expect(required(document.querySelector<HTMLSelectElement>("#vpc")).value).toBe("vpc-b");
  expect(
    [...document.querySelectorAll<HTMLInputElement>("#subnets input:checked")].map((n) => n.value),
  ).toEqual(["subnet-b"]);
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
});

it("network and subnet edits retire pending plan success and errors without stale publication", async () => {
  for (const field of ["network", "subnet"])
    for (const failed of [false, true]) {
      const data = handoffState(),
        pending = deferred(),
        plan = pendingPlanFixture(data);
      window.history.replaceState(null, "", "/#/connections");
      await boot(async (path) => {
        if (path === "/api/v1/plans") return pending.promise;
        throw new Error(`Unexpected client fixture request ${path}`);
      }, data);
      required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
      await vi.waitFor(() =>
        expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(false),
      );
      required(document.querySelector("#plan-form")).dispatchEvent(new Event("submit", { cancelable: true }));
      const calls = vi.mocked(fetch).mock.calls.length;
      if (field === "network") handoffChoice("network", "net-b");
      else {
        const input = required(document.querySelector<HTMLInputElement>("#subnets input"));
        input.checked = false;
        input.dispatchEvent(new Event("change"));
      }
      data.plans = [plan];
      const late = failed
        ? new Response(JSON.stringify({ error: "Retired plan failure" }), { status: 409 })
        : response(plan);
      pending.resolve(late);
      await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
      await new Promise((done) => setTimeout(done, 0));
      expect(window.location.hash).toBe("#/connections");
      expect(document.querySelector("#notice")?.textContent).toBe("");
      expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
      if (field === "network")
        expect(required(document.querySelector<HTMLSelectElement>("#network")).value).toBe("net-b");
      else expect(required(document.querySelector<HTMLInputElement>("#subnets input")).checked).toBe(false);
    }
});

it("retired plan refresh does not commit selection and removed inputs cannot retire a newer plan", async () => {
  const data = handoffState(),
    old = pendingPlanFixture(data),
    newer = { ...pendingPlanFixture(data), id: "newer-client-plan", digest: "e".repeat(64) };
  newer.request = { ...newer.request, network_id: "net-b" };
  window.history.replaceState(null, "", "/#/connections");
  await boot(async () => {
    throw new Error("Unexpected initial request");
  }, data);
  const delayedRefresh = deferred(),
    currentPost = deferred();
  let posts = 0,
    snapshots = 0;
  vi.mocked(fetch).mockImplementation((input) => {
    const path = String(input);
    if (path === "/api/v1/plans") return ++posts === 1 ? Promise.resolve(response(old)) : currentPost.promise;
    if (path === "/api/v1/snapshot")
      return ++snapshots === 1 ? delayedRefresh.promise : Promise.resolve(response(data));
    throw new Error(`Unexpected client fixture request ${path}`);
  });
  required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
  await vi.waitFor(() =>
    expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(false),
  );
  const removed = required(document.querySelector<HTMLInputElement>("#subnets input"));
  required(document.querySelector("#plan-form")).dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(snapshots).toBe(1));
  handoffChoice("network", "net-b");
  data.plans = [newer, old];
  const late = response(data);
  delayedRefresh.resolve(late);
  await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
  await new Promise((done) => setTimeout(done, 0));
  expect(window.location.hash).toBe("#/connections");
  required(document.querySelector<HTMLButtonElement>("#refresh")).click();
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>("#plan-list article")?.dataset.planId).toBe(newer.id),
  );
  expect(removed.isConnected).toBe(false);
  required(document.querySelector("#plan-form")).dispatchEvent(new Event("submit", { cancelable: true }));
  expect(posts).toBe(2);
  removed.checked = false;
  removed.dispatchEvent(new Event("change"));
  currentPost.resolve(response(newer));
  await vi.waitFor(() => expect(window.location.hash).toBe("#/plans"));
  expect(document.querySelector<HTMLElement>("#plan-list article")?.dataset.planId).toBe(newer.id);
  handoffChoice("plan-selection", old.id);
  expect(document.querySelector<HTMLElement>("#plan-list article")?.dataset.planId).toBe(old.id);
  expect(
    document.querySelector('[aria-label="Plan impact comparison"]')?.getAttribute("data-plan-digest"),
  ).toBe(old.digest);
});

it("snapshot replacement retires pending plan publication even when connection inputs stay equal", async () => {
  const data = handoffState(),
    pending = deferred(),
    plan = pendingPlanFixture(data);
  window.history.replaceState(null, "", "/#/connections");
  await boot(async (path) => {
    if (path === "/api/v1/plans") return pending.promise;
    throw new Error(`Unexpected client fixture request ${path}`);
  }, data);
  required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
  await vi.waitFor(() =>
    expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(false),
  );
  required(document.querySelector("#plan-form")).dispatchEvent(new Event("submit", { cancelable: true }));
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.method).toBe("POST");
  required(document.querySelector<HTMLButtonElement>("#refresh")).click();
  await vi.waitFor(() => expect(document.querySelector("#notice")?.textContent).toContain("Updated."));
  const calls = vi.mocked(fetch).mock.calls.length,
    notice = document.querySelector("#notice")?.textContent;
  data.plans = [plan];
  const late = response(plan);
  pending.resolve(late);
  await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
  await new Promise((done) => setTimeout(done, 0));
  expect(window.location.hash).toBe("#/connections");
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  expect(document.querySelector("#notice")?.textContent).toBe(notice);
});

it("main preselects only the inspected subnet and preserves explicit whole-VPC configuration", async () => {
  const data = handoffState(),
    row = data.inventory[1].subnets[0],
    picked = { ...row, id: " subnet-b-extra " };
  data.inventory[1].subnets.push(picked, { ...row, id: "last" });
  window.history.replaceState(null, "", "/#/networks");
  await boot(async () => {
    throw new Error("No automatic subnet handoff request");
  }, data);
  handoffChoice("workspace-network", "net-b");
  handoffChoice("workspace-vpc", JSON.stringify(["b", "vpc-b"]));
  required(
    document.querySelector<HTMLButtonElement>(`button[aria-label="Inspect subnet ${picked.id}"]`),
  ).click();
  const action = required(
      [...document.querySelectorAll<HTMLButtonElement>("#network-list button")].find(
        (b) => b.textContent === "Configure selected subnet",
      ),
    ),
    calls = vi.mocked(fetch).mock.calls.length;
  action.click();
  expect(window.location.hash).toBe("#/connections");
  expect(
    [...document.querySelectorAll<HTMLInputElement>("#subnets input:checked")].map((i) => i.value),
  ).toEqual([picked.id]);
  expect(document.querySelectorAll("#subnets input")).toHaveLength(3);
  expect(required(document.querySelector<HTMLSelectElement>("#vpc")).value).toBe("vpc-b");
  expect(required(document.querySelector<HTMLSelectElement>("#network")).value).toBe("net-b");
  window.location.hash = "#/networks";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  handoffChoice("workspace-vpc", JSON.stringify(["a", "vpc-a"]));
  action.click();
  expect(window.location.hash).toBe("#/networks");
  expect(
    [...document.querySelectorAll<HTMLInputElement>("#subnets input:checked")].map((i) => i.value),
  ).toEqual([picked.id]);
  handoffChoice("workspace-vpc", JSON.stringify(["b", "vpc-b"]));
  handoffButton().click();
  expect(
    [...document.querySelectorAll<HTMLInputElement>("#subnets input:checked")].map((i) => i.value),
  ).toEqual(data.inventory[1].subnets.map((s) => s.id));
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
});

it("main refuses unrepresentable or read-only selected-subnet handoff without changing form or sending requests", async () => {
  for (const variant of ["duplicate-vpc", "missing-vpc-option", "duplicate-network-option", "read-only"]) {
    const data = handoffState();
    if (variant === "duplicate-vpc") data.inventory[1].vpc_id = data.inventory[0].vpc_id;
    if (variant === "read-only") data.role = "read_only";
    window.history.replaceState(null, "", "/#/networks");
    await boot(async () => {
      throw new Error("Rejected subnet handoff must stay local");
    }, data);
    required(
      document.querySelector<HTMLButtonElement>('button[aria-label="Inspect subnet subnet-a"]'),
    ).click();
    if (variant === "missing-vpc-option") required(document.querySelector("#vpc option")).remove();
    if (variant === "duplicate-network-option")
      required(document.querySelector("#network")).append(
        required(document.querySelector("#network option")).cloneNode(true),
      );
    const form = required(document.querySelector("#plan-form")),
      before = form.innerHTML,
      calls = vi.mocked(fetch).mock.calls.length;
    const action = required(
      [...document.querySelectorAll<HTMLButtonElement>("#network-list button")].find(
        (b) => b.textContent === "Configure selected subnet",
      ),
    );
    if (variant === "read-only") expect(action.disabled).toBe(true);
    action.disabled = false;
    action.click();
    expect(window.location.hash).toBe("#/networks");
    expect(form.innerHTML).toBe(before);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    if (variant !== "read-only")
      expect(document.querySelector("#notice")?.textContent).toContain("cannot be represented uniquely");
  }
});

it("an intervening same-value refresh retires plan generation navigation during its followup", async () => {
  const data = handoffState(),
    plan = pendingPlanFixture(data),
    reload = deferred();
  window.history.replaceState(null, "", "/#/connections");
  await boot(async () => {
    throw new Error("Unexpected initial fixture request");
  }, data);
  let reads = 0;
  vi.mocked(fetch).mockImplementation((input) => {
    const path = String(input);
    if (path === "/api/v1/snapshot") return ++reads === 1 ? reload.promise : Promise.resolve(response(data));
    if (path === "/api/v1/plans") return Promise.resolve(response(plan));
    throw new Error(`Unexpected fixture path ${path}`);
  });
  required(document.querySelector<HTMLButtonElement>("#configure-connection")).click();
  await vi.waitFor(() =>
    expect(required(document.querySelector<HTMLElement>("#connection-configure")).hidden).toBe(false),
  );
  const checkbox = required(document.querySelector<HTMLInputElement>("#subnets input"));
  required(document.querySelector("#plan-form")).dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(reads).toBe(1));
  data.plans = [plan];
  required(document.querySelector<HTMLButtonElement>("#refresh")).click();
  await vi.waitFor(() => expect(checkbox.isConnected).toBe(false));
  expect(document.querySelector("#notice")?.textContent).toContain("Updated.");
  const late = response(data);
  reload.resolve(late);
  await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
  await new Promise((done) => setTimeout(done, 0));
  expect(window.location.hash).toBe("#/connections");
  expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path) === "/api/v1/plans")).toHaveLength(1);
});

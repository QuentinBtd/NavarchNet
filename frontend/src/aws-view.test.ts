import { describe, expect, it, vi } from "vitest";
import { renderAwsTopology } from "./aws-view";
import type { AdoptionConsent, AwsResource, TopologyView } from "./generated";

function fixture(): TopologyView {
  const vpc: AwsResource = {
    kind: "vpc",
    id: "vpc-01111111111111111",
    owner_account_id: "123456789012",
    vpc_id: null,
    subnet_id: null,
    az_id: null,
    state: "available",
    cidrs: ["10.1.0.0/16"],
    public_ips: ["203.0.113.10"],
    private_ips: [],
    tags: { Name: "<img src=x onerror=alert(1)>" },
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
  };
  return {
    topology: {
      id: "snapshot",
      account_id: "account",
      aws_account_id: "123456789012",
      region: "eu-west-1",
      started_at: "1",
      completed_at: "2",
      session_name: "navarchnet-fixture",
      resources: [vpc],
      request_ids: ["fixture"],
      complete_for_supported_queries: true,
      limitations: ["TGW routing is not fully discovered"],
      execution_enabled: false,
      connectivity_tested: false,
    },
    adoptions: [],
    subnet_route_tables: [],
  };
}
describe("read-only AWS observations", () => {
  it("keeps CIDR controls optional/lazy and retires retained actions when resource paging recreates cards", () => {
    const view = fixture(),
      first = view.topology.resources[0];
    if (!first) throw new Error("Missing fixture");
    view.topology.resources = [
      first,
      { ...first, kind: "subnet", id: "subnet-a", vpc_id: first.id },
      ...Array.from({ length: 199 }, (_, index) => ({ ...first, id: `vpc-extra-${index}` })),
    ];
    view.subnet_route_tables = [
      {
        subnet_id: "subnet-a",
        vpc_id: first.id,
        selection: { status: "unresolved", reason: "missing_route_table" },
      },
    ];
    const options = { canConsent: false, onConsent: async () => {} };
    expect(renderAwsTopology(view, options).querySelector("[data-vpc-cidr-inspector]")).toBeNull();
    const lookup = vi.fn(async () => undefined);
    const node = renderAwsTopology(view, { ...options, onVpcCidrCoverage: lookup });
    const detail = node.querySelector<HTMLDetailsElement>("[data-vpc-cidr-inspector]");
    if (!detail) throw new Error("Missing inspector");
    expect(detail.querySelector("input")).toBeNull();
    detail.open = true;
    detail.dispatchEvent(new Event("toggle"));
    const input = detail.querySelector("input"),
      action = detail.querySelector("button");
    if (!input || !action) throw new Error("Missing controls");
    const more = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Show more observed records",
    );
    if (!more) throw new Error("Missing resource continuation");
    more.click();
    expect(node.contains(detail)).toBe(false);
    input.value = "10.0.0.0/16";
    action.click();
    expect(lookup).not.toHaveBeenCalled();
    expect(node.querySelectorAll("[data-vpc-cidr-inspector]")).toHaveLength(1);
    expect(node.querySelector("[data-vpc-cidr-inspector] input")).toBeNull();
  });
  it("lazily shows every literal NAT tuple without choosing a primary or successful egress", () => {
    const view = fixture();
    const resource = view.topology.resources[0];
    if (!resource) throw new Error("Missing fixture");
    resource.kind = "nat_gateway";
    resource.nat_gateway = {
      route_table_id: "nat-<img src=x>",
      addresses: ["succeeded", "failed", "future-status"].map((status, index) => ({
        allocation_id: "eipalloc-a",
        association_id: null,
        network_interface_id: null,
        public_ip: `203.0.113.${index + 1}`,
        private_ip: null,
        az_id: index === 2 ? null : `euw1-az${index + 1}`,
        az_name: "eu-west-1a",
        is_primary: index === 2 ? null : index === 0,
        status,
      })),
    };
    const before = JSON.stringify(view);
    const node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    const detail = node.querySelector<HTMLDetailsElement>("details[data-nat-metadata]");
    if (!detail) throw new Error("Missing NAT metadata detail");
    expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(0);
    detail.open = true;
    detail.dispatchEvent(new Event("toggle"));
    detail.dispatchEvent(new Event("toggle"));
    expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(3);
    for (const value of [
      "succeeded",
      "failed",
      "future-status",
      "Reported primary: true",
      "Reported primary: false",
      "Reported primary: not reported",
      "AZ ID: not reported",
      "nat-<img src=x>",
      "Unvalidated routeTableId reference",
      "not selected egress IPs",
      "not NAT health or a selected traffic AZ",
      "snapshot",
      "2",
    ])
      expect(detail.textContent).toContain(value);
    expect(detail.querySelector("img, a, form, input, select")).toBeNull();
    expect(JSON.stringify(view)).toBe(before);
  });
  it("distinguishes legacy, omitted and explicit empty NAT metadata without inferring a mode", () => {
    const cases: [AwsResource["nat_gateway"], string][] = [
      [null, "NAT details not captured in this observation"],
      [{ route_table_id: null, addresses: null }, "Address collection not reported"],
      [{ route_table_id: null, addresses: [] }, "Reported address tuples: 0"],
    ];
    for (const [metadata, expected] of cases) {
      const view = fixture();
      const resource = view.topology.resources[0];
      if (!resource) throw new Error("Missing fixture");
      resource.kind = "nat_gateway";
      resource.nat_gateway = metadata;
      const node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
      const detail = node.querySelector<HTMLDetailsElement>("details[data-nat-metadata]");
      if (!detail) throw new Error("Missing NAT metadata detail");
      detail.open = true;
      detail.dispatchEvent(new Event("toggle"));
      expect(detail.textContent).toContain(expected);
      expect(detail.textContent).toContain("Availability mode: not reported");
      expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(0);
    }
  });
  it("rejects malformed NAT metadata before showing a valid subset or invalid primary marker", () => {
    const address = {
      allocation_id: null,
      association_id: null,
      network_interface_id: null,
      public_ip: "203.0.113.1",
      private_ip: null,
      az_id: "euw1-az1",
      az_name: null,
      is_primary: null,
      status: "succeeded",
    };
    for (const metadata of [
      {},
      { route_table_id: [], addresses: [] },
      { route_table_id: null, addresses: {} },
      { route_table_id: null, addresses: [address, null] },
      { route_table_id: null, addresses: [address, { ...address, is_primary: "false" }] },
      { route_table_id: null, addresses: [address, { ...address, status: 1 }] },
    ]) {
      const view = fixture();
      const resource = view.topology.resources[0];
      if (!resource) throw new Error("Missing fixture");
      resource.kind = "nat_gateway";
      resource.nat_gateway = metadata as unknown as AwsResource["nat_gateway"];
      const node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
      const detail = node.querySelector<HTMLDetailsElement>("details[data-nat-metadata]");
      if (!detail) throw new Error("Missing NAT metadata detail");
      detail.open = true;
      detail.dispatchEvent(new Event("toggle"));
      expect(detail.textContent).toContain("NAT metadata is malformed; no address tuples displayed");
      expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(0);
    }
  });
  it("bounds lazy NAT DOM batches without silently truncating the reported collection", () => {
    const view = fixture();
    const resource = view.topology.resources[0];
    if (!resource) throw new Error("Missing fixture");
    resource.kind = "nat_gateway";
    resource.nat_gateway = {
      route_table_id: null,
      addresses: Array.from({ length: 101 }, (_, index) => ({
        allocation_id: null,
        association_id: null,
        network_interface_id: null,
        public_ip: `203.0.113.${index}`,
        private_ip: null,
        az_name: null,
        az_id: null,
        is_primary: null,
        status: "future-status",
      })),
    };
    const node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    const detail = node.querySelector<HTMLDetailsElement>("details[data-nat-metadata]");
    if (!detail) throw new Error("Missing NAT metadata detail");
    expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(0);
    detail.open = true;
    detail.dispatchEvent(new Event("toggle"));
    expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(50);
    expect(detail.textContent).toContain("Showing 50 of 101 reported address tuples");
    const more = detail.querySelector<HTMLButtonElement>("button[data-nat-more]");
    if (!more) throw new Error("Missing address continuation button");
    expect(more.type).toBe("button");
    more.click();
    expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(100);
    more.click();
    more.click();
    expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(101);
    expect(detail.textContent).toContain("203.0.113.100");
    expect(detail.textContent).toContain("Showing 101 of 101 reported address tuples");
    expect(more.hidden).toBe(true);
  });
  it("does not display NAT details under missing or non-false offline markers or absent snapshot identity", () => {
    for (const change of [
      { execution_enabled: true },
      { execution_enabled: undefined },
      { execution_enabled: null },
      { connectivity_tested: true },
      { connectivity_tested: undefined },
      { id: "" },
      { completed_at: "" },
    ]) {
      const view = fixture();
      Object.assign(view.topology, change);
      const resource = view.topology.resources[0];
      if (!resource) throw new Error("Missing fixture");
      resource.kind = "nat_gateway";
      resource.nat_gateway = { route_table_id: "rtb-must-not-display", addresses: [] };
      const node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
      const detail = node.querySelector<HTMLDetailsElement>("details[data-nat-metadata]");
      if (!detail) throw new Error("Missing NAT metadata detail");
      detail.open = true;
      detail.dispatchEvent(new Event("toggle"));
      expect(detail.textContent).toContain(
        "Offline snapshot identity or markers are invalid; refresh the observation",
      );
      expect(detail.textContent).not.toContain("rtb-must-not-display");
    }
  });
  it("offers saved-table lookup to a reader and displays only a matching immutable snapshot response", async () => {
    const view = fixture();
    const row = view.topology.resources[0];
    if (!row) throw new Error("Missing fixture");
    row.kind = "transit_gateway_route_table";
    const calls: unknown[] = [];
    const node = renderAwsTopology(view, {
      canConsent: false,
      onConsent: async () => {},
      onLookup: async (query) => {
        calls.push(query);
        return {
          topology_id: "snapshot",
          route_table_id: row.id,
          destination: query.destination,
          result: {
            status: "reported_forward",
            destination_cidr: "0.0.0.0/0",
            route_type: "static",
            attachment_ids: ["<img src=x>"],
          },
          execution_enabled: false,
          connectivity_tested: false,
        };
      },
    });
    const form = node.querySelector<HTMLFormElement>("form[data-route-lookup]");
    expect(form).not.toBeNull();
    const input = form?.querySelector<HTMLInputElement>("input");
    if (!input || !form) throw new Error("Saved lookup input missing");
    input.value = "203.0.113.1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await expect.poll(() => node.textContent).toContain("Reported table match");
    expect(calls).toEqual([{ route_table_id: row.id, destination: "203.0.113.1" }]);
    expect(node.textContent).toContain("not a full path or measured connectivity");
    expect(node.querySelector("img")).toBeNull();
  });
  it("refuses a response from a different saved snapshot", async () => {
    const view = fixture();
    const row = view.topology.resources[0];
    if (!row) throw new Error("Missing fixture");
    row.kind = "transit_gateway_route_table";
    const node = renderAwsTopology(view, {
      canConsent: false,
      onConsent: async () => {},
      onLookup: async (query) => ({
        topology_id: "newer-snapshot",
        route_table_id: row.id,
        destination: query.destination,
        result: { status: "reported_blackhole", destination_cidr: "0.0.0.0/0" },
        execution_enabled: false,
        connectivity_tested: false,
      }),
    });
    const form = node.querySelector<HTMLFormElement>("form[data-route-lookup]");
    const input = form?.querySelector<HTMLInputElement>("input");
    if (!form || !input) throw new Error("Saved lookup form missing");
    input.value = "203.0.113.1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await expect.poll(() => node.textContent).toContain("Snapshot changed; refresh the saved observation");
    expect(node.textContent).not.toContain("Reported blackhole");
  });
  it("shows unknown, completed empty and typed TGW routes without resolving prefix lists or claiming forwarding", () => {
    const view = fixture();
    const row = view.topology.resources[0];
    if (!row) throw new Error("Missing fixture");
    row.kind = "transit_gateway_route_table";
    let node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    expect(node.textContent).toContain("TGW routes not queried");
    row.tgw_routes = [];
    node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    expect(node.textContent).toContain("TGW routes: 0");
    row.tgw_routes = [
      {
        destination_cidr: "::/0",
        prefix_list_id: "pl-unresolved",
        state: "blackhole",
        route_type: "static",
        route_table_announcement_id: "<img src=x>",
        attachments: [
          { attachment_id: "tgw-attach-fixture", resource_id: null, resource_type: "future-type" },
        ],
      },
    ];
    node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    expect(node.textContent).toContain("::/0");
    expect(node.textContent).toContain("blackhole");
    expect(node.textContent).toContain("pl-unresolved");
    expect(node.textContent).toContain("Prefix-list entries are unresolved");
    expect(node.textContent).toContain("tgw-attach-fixture");
    expect(node.querySelector("img")).toBeNull();
  });
  it("distinguishes unqueried TGW data from empty reads and preserves transitional relationship states", () => {
    const view = fixture();
    const row = view.topology.resources[0];
    if (!row) throw new Error("Missing fixture");
    row.kind = "transit_gateway_route_table";
    row.id = "tgw-rtb-fixture";
    let node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    expect(node.textContent).toContain("TGW associations not queried");
    row.tgw_associations = [];
    row.tgw_propagations = [
      {
        attachment_id: null,
        resource_id: null,
        resource_type: "<img src=x>",
        state: "enabling",
        route_table_announcement_id: "tgw-rtb-announcement-fixture",
      },
    ];
    node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    expect(node.textContent).toContain("TGW associations: 0");
    expect(node.textContent).toContain("TGW propagations: 1");
    expect(node.textContent).toContain("enabling");
    expect(node.textContent).toContain("tgw-rtb-announcement-fixture");
    expect(node.textContent).toContain("do not prove forwarding");
    expect(node.querySelector("img")).toBeNull();
  });
  it("shows observed table selection and unresolved cases without claiming an effective path", () => {
    const view = fixture();
    view.subnet_route_tables = [
      {
        subnet_id: "subnet-main",
        vpc_id: "vpc-a",
        selection: { status: "selected", route_table_id: "rtb-main", source: "implicit_main" },
      },
      {
        subnet_id: "<img src=x>",
        vpc_id: "vpc-a",
        selection: { status: "unresolved", reason: "association_not_ready" },
      },
    ];
    const resource = view.topology.resources[0];
    if (!resource) throw new Error("Missing fixture");
    view.topology.resources.push(
      { ...resource, kind: "subnet", id: "subnet-main" },
      { ...resource, kind: "subnet", id: "<img src=x>" },
    );
    const node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    expect(node.textContent).toContain("subnet-main → rtb-main");
    expect(node.textContent).toContain("implicit_main");
    expect(node.textContent).toContain("association_not_ready");
    expect(node.textContent).toContain("not an effective packet path");
    expect(node.querySelector("img")).toBeNull();
  });
  it("escapes provider text, shows reported public IPs and never claims measured egress", () => {
    const node = renderAwsTopology(fixture(), { canConsent: false, onConsent: async () => {} });
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(node.textContent).toContain("203.0.113.10");
    expect(node.textContent).toContain("not a tested egress path");
    expect(node.textContent).toContain("AWS execution is disabled");
    expect(node.querySelector("form")).toBeNull();
  });
  it("requires explicit reason and only offers owned VPC/TGW metadata consent", () => {
    const view = fixture();
    const original = view.topology.resources[0];
    if (!original) throw new Error("Fixture missing VPC");
    view.topology.resources.push({ ...original, id: "vpc-foreign", owner_account_id: "999999999999" });
    view.topology.resources.push({ ...original, kind: "route_table", id: "rtb-unsupported" });
    let received: AdoptionConsent | undefined;
    const node = renderAwsTopology(view, {
      canConsent: true,
      onConsent: async (consent) => {
        received = consent;
      },
    });
    expect(node.querySelectorAll("form")).toHaveLength(1);
    const input = node.querySelector<HTMLInputElement>("input");
    const form = node.querySelector("form");
    if (!input || !form) throw new Error("Adoption form missing");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(received).toBeUndefined();
    input.value = "Metadata consent only; no route or resource changes";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(received).toEqual({
      topology_id: "snapshot",
      resource_kind: "vpc",
      resource_id: original.id,
      reason: input.value,
    });
  });
  it("does not offer consent for incomplete observations", () => {
    const view = fixture();
    view.topology.complete_for_supported_queries = false;
    expect(
      renderAwsTopology(view, { canConsent: true, onConsent: async () => {} }).querySelector("form"),
    ).toBeNull();
  });
  it("pages observed records without presenting a bounded subset as the full inventory", () => {
    const view = fixture();
    const first = view.topology.resources[0];
    if (!first) throw new Error("Fixture missing VPC");
    view.topology.resources = Array.from({ length: 201 }, (_, index) => ({
      ...first,
      id: `vpc-fixture-${index}`,
    }));
    const node = renderAwsTopology(view, { canConsent: false, onConsent: async () => {} });
    expect(node.querySelectorAll("article")).toHaveLength(200);
    expect(node.textContent).toContain("Showing 200 of 201");
    const more = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Show more observed records",
    );
    if (!more) throw new Error("Observed-record continuation missing");
    more.click();
    expect(node.querySelectorAll("article")).toHaveLength(201);
    expect(node.textContent).toContain("Showing 201 of 201");
  });
});

import { describe, expect, it } from "vitest";
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
    related_ids: [],
    connectivity_type: null,
    availability_mode: null,
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
    node.querySelector<HTMLButtonElement>("button")?.click();
    expect(node.querySelectorAll("article")).toHaveLength(201);
    expect(node.textContent).toContain("Showing 201 of 201");
  });
});

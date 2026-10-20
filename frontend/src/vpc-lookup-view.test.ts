import { expect, it } from "vitest";
import type { RouteTableSelection, TgwLookupResponse, VpcLookupResponse } from "./generated";
import { renderTgwLookup } from "./tgw-lookup-view";
import { renderVpcLookup } from "./vpc-lookup-view";

// Renderer fixtures exercise untrusted/malformed HTTP shapes, not backend or AWS acceptance.
const selection: RouteTableSelection = {
  status: "selected",
  route_table_id: "rtb-main",
  source: "implicit_main",
};
const value: VpcLookupResponse = {
  topology_id: "snapshot",
  subnet_id: "subnet-a",
  destination: "203.0.113.1",
  result: {
    status: "reported",
    route_table_id: "rtb-main",
    source: "implicit_main",
    lookup: {
      status: "reported_route",
      destination_cidr: "0.0.0.0/0",
      origin: "CreateRoute",
      target: { kind: "transit_gateway", id: "tgw-fixture" },
    },
  },
  execution_enabled: false,
  connectivity_tested: false,
};
function render(body: unknown, table: RouteTableSelection = selection) {
  return renderVpcLookup("snapshot", "subnet-a", table, 0, async () => body as VpcLookupResponse);
}
async function submit(form: HTMLFormElement) {
  const input = form.querySelector<HTMLInputElement>("input");
  const status = form.querySelector<HTMLElement>('[role="status"]');
  if (!input || !status) throw new Error("Lookup controls missing");
  input.value = "203.0.113.1";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await expect.poll(() => status.textContent).not.toContain("Reading saved");
  expect(input.disabled).toBe(false);
  expect(form.querySelector("button")?.disabled).toBe(false);
  return status.textContent;
}
it("renders supported target descriptions as inert text without claiming target health", async () => {
  for (const [target, label] of [
    [{ kind: "transit_gateway", id: "tgw-fixture" }, "transit gateway: tgw-fixture"],
    [{ kind: "nat_gateway", id: "<img src=x>" }, "NAT gateway: <img src=x>"],
    [{ kind: "internet_gateway", id: "igw-fixture" }, "internet gateway: igw-fixture"],
    [{ kind: "local" }, "VPC local"],
  ] as const) {
    if (value.result.status !== "reported" || value.result.lookup.status !== "reported_route")
      throw new Error("Bad fixture");
    const form = render({
      ...value,
      result: { ...value.result, lookup: { ...value.result.lookup, target } },
    });
    expect(await submit(form)).toContain(label);
    expect(form.textContent).toContain("target health and connectivity remain untested");
    expect(form.querySelector("img")).toBeNull();
  }
});
it("rejects changed subnet/table/source/destination and absent or enabled execution flags", async () => {
  for (const body of [
    { ...value, subnet_id: "other" },
    { ...value, destination: "other" },
    { ...value, result: { ...value.result, route_table_id: "other" } },
    { ...value, result: { ...value.result, source: "explicit_subnet" } },
    { ...value, execution_enabled: true },
    { ...value, connectivity_tested: true },
    { ...value, execution_enabled: undefined },
    { ...value, connectivity_tested: undefined },
    { ...value, result: { status: "future" } },
  ]) {
    const form = render(body);
    expect(await submit(form)).toContain("did not match the requested saved subnet scope");
    expect(form.textContent).not.toContain("Reported subnet entry");
  }
  expect(await submit(render({ ...value, topology_id: "newer" }))).toContain("Snapshot changed; refresh");
});
it("distinguishes blackholes and unresolved entry, scope and association evidence", async () => {
  for (const [result, expected, table] of [
    [
      {
        status: "reported",
        route_table_id: "rtb-main",
        source: "implicit_main",
        lookup: { status: "reported_blackhole", destination_cidr: "0.0.0.0/0" },
      },
      "Reported subnet blackhole",
      selection,
    ],
    [
      {
        status: "reported",
        route_table_id: "rtb-main",
        source: "implicit_main",
        lookup: { status: "unresolved", reason: "unsupported_target" },
      },
      "Unresolved: unsupported_target",
      selection,
    ],
    [{ status: "unresolved", reason: "scope_not_ready" }, "Unresolved: scope_not_ready", selection],
    [
      { status: "association_unresolved", reason: "association_not_ready" },
      "Table association unresolved: association_not_ready",
      { status: "unresolved", reason: "association_not_ready" },
    ],
  ] as const) {
    expect(await submit(render({ ...value, result }, table))).toContain(expected);
  }
  expect(
    await submit(
      render({ ...value, result: { status: "association_unresolved", reason: "association_not_ready" } }),
    ),
  ).toContain("did not match");
});
it("requires explicit false execution/connectivity flags in the sibling TGW renderer too", async () => {
  for (const field of ["execution_enabled", "connectivity_tested"]) {
    const response: Record<string, unknown> = {
      topology_id: "snapshot",
      route_table_id: "table",
      destination: "203.0.113.1",
      result: { status: "reported_blackhole", destination_cidr: "0.0.0.0/0" },
      execution_enabled: false,
      connectivity_tested: false,
    };
    delete response[field];
    const form = renderTgwLookup(
      "snapshot",
      "table",
      1,
      async () => response as unknown as TgwLookupResponse,
    );
    expect(await submit(form)).toContain("Lookup response did not match");
    expect(form.textContent).not.toContain("Reported blackhole");
  }
});

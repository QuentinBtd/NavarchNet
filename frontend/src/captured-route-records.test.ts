import { afterEach, expect, it } from "vitest";
import { renderCapturedRouteRecords } from "./captured-route-records";
import type { AwsResource, AwsTopology, ObservedRoute, TransitGatewayRoute } from "./generated";
import { renderSavedAwsWorkspace } from "./saved-aws-workspace";

const route = (i = 0): ObservedRoute => ({
  ipv4_destination: `10.${i}.0.0/16`,
  ipv6_destination: null,
  prefix_list_destination: null,
  state: "active",
  origin: "CreateRoute",
  targets: { transitGatewayId: "unvalidated-tgw" },
});
const tgw = (): TransitGatewayRoute => ({
  destination_cidr: "0.0.0.0/0",
  prefix_list_id: null,
  state: "blackhole",
  route_type: "future-type",
  route_table_announcement_id: null,
  attachments: [
    { attachment_id: "same", resource_id: null, resource_type: "unknown" },
    { attachment_id: "same", resource_id: "foreign-literal", resource_type: null },
  ],
});
function resource(kind: AwsResource["kind"] = "route_table"): AwsResource {
  return {
    kind,
    id: "saved-table",
    owner_account_id: null,
    vpc_id: null,
    subnet_id: null,
    az_id: null,
    state: null,
    cidrs: [],
    public_ips: [],
    private_ips: [],
    tags: {},
    routes: [route()],
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
}
const context = { id: "capture", completed_at: "original-time", resource_index: 7 };
function mount(value = resource(), current = () => true) {
  const root = renderCapturedRouteRecords(value, context, current);
  if (!root) throw new Error("Route detail missing");
  document.body.append(root);
  return root;
}
function open(root: HTMLDetailsElement) {
  root.open = true;
  root.dispatchEvent(new Event("toggle"));
}
function raw(root: HTMLElement, index = 0) {
  const detail = root.querySelector<HTMLDetailsElement>(`[data-route-index="${index}"] details`);
  if (!detail) throw new Error("Original route detail missing");
  open(detail);
  return JSON.parse(detail.querySelector("pre")?.textContent ?? "null");
}
afterEach(() => document.body.replaceChildren());

it("keeps literal VPC targets blackholes prefix lists and original JSON without selecting a path", () => {
  const value = resource();
  value.routes = [
    {
      ...route(),
      ipv6_destination: "future-ipv6-literal",
      prefix_list_destination: "pl-unresolved",
      state: "blackhole",
      targets: { natGatewayId: "nat-literal", gatewayId: "other-literal", futureField: "" },
    },
    { ...route(1), state: null, origin: "", targets: {} },
  ];
  const before = structuredClone(value),
    root = mount(value);
  expect(root.querySelectorAll("[data-route-index]")).toHaveLength(0);
  open(root);
  open(root);
  expect(root.dataset.captureId).toBe("capture");
  expect(root.dataset.resourceIndex).toBe("7");
  for (const literal of [
    "blackhole",
    "pl-unresolved",
    "nat-literal",
    "other-literal",
    "futureField: empty reported value",
    "Not effective routing or measured traffic",
  ])
    expect(root.textContent).toContain(literal);
  expect(root.querySelectorAll("[data-route-index]")).toHaveLength(2);
  expect(raw(root)).toEqual(value.routes[0]);
  expect(raw(root, 1)).toEqual(value.routes[1]);
  expect(value).toEqual(before);
});

it("distinguishes uncaptured empty and literal TGW attachment collections without resolving references", () => {
  const value = resource("transit_gateway_route_table");
  const unknown = mount(value);
  open(unknown);
  expect(unknown.textContent).toContain("collection not captured");
  value.tgw_routes = [];
  const empty = mount(value);
  open(empty);
  expect(empty.textContent).toContain("Zero route records returned");
  value.tgw_routes = [tgw()];
  const root = mount(value);
  open(root);
  expect(root.textContent).toContain("blackhole");
  expect(root.textContent).toContain("future-type");
  expect(root.textContent).toContain("attachment rows: 2");
  expect(raw(root)).toEqual(value.tgw_routes[0]);
});

it("validates later accessed route and nested attachment shapes before displaying any prefix", () => {
  const cases: AwsResource[] = [];
  const invalid = resource();
  invalid.routes = [
    ...Array.from({ length: 24 }, (_, i) => route(i)),
    { ...route(), targets: { bad: 3 } as unknown as Record<string, string> },
  ];
  cases.push(invalid);
  const sparse = resource();
  sparse.routes = Array(25) as ObservedRoute[];
  sparse.routes[0] = route();
  cases.push(sparse);
  const missing = resource();
  missing.routes[0].origin = undefined as unknown as null;
  cases.push(missing);
  const nested = resource("transit_gateway_route_table");
  nested.tgw_routes = [tgw(), { ...tgw(), attachments: Array(2) }];
  cases.push(nested);
  const omitted = resource("transit_gateway_route_table");
  omitted.tgw_routes = undefined as unknown as null;
  cases.push(omitted);
  for (const value of cases) {
    const root = mount(value);
    open(root);
    expect(root.textContent).toContain("malformed");
    expect(root.querySelectorAll("[data-route-index]")).toHaveLength(0);
  }
});

it("reveals all route rows in twelve-entry batches retaining original indexes without duplicate toggles", () => {
  const value = resource();
  value.routes = Array.from({ length: 29 }, (_, i) => route(i));
  const root = mount(value);
  open(root);
  expect(root.querySelectorAll("[data-route-index]")).toHaveLength(12);
  const more = root.querySelector("button");
  if (!more) throw new Error("Continuation missing");
  more.click();
  open(root);
  expect(root.querySelectorAll("[data-route-index]")).toHaveLength(24);
  more.click();
  more.click();
  expect(
    [...root.querySelectorAll<HTMLElement>("[data-route-index]")].map((n) => Number(n.dataset.routeIndex)),
  ).toEqual(Array.from({ length: 29 }, (_, i) => i));
  expect(root.textContent).toContain("Showing 29 of 29");
  expect(more.hidden).toBe(true);
  expect(raw(root, 28)).toEqual(value.routes[28]);
});

it("retires retained route continuations and lazy JSON when parent map selection replaces the inspector", () => {
  const r = resource();
  r.routes = Array.from({ length: 29 }, (_, i) => route(i));
  const other = { ...resource("nat_gateway"), id: "other" };
  const data: AwsTopology = {
    id: context.id,
    completed_at: context.completed_at,
    account_id: "registration",
    aws_account_id: "123456789012",
    region: "eu-west-1",
    started_at: "old",
    session_name: "fixture",
    resources: [r, other],
    request_ids: [],
    complete_for_supported_queries: true,
    limitations: [],
    execution_enabled: false,
    connectivity_tested: false,
  };
  const map = renderSavedAwsWorkspace(data, () => true);
  document.body.append(map);
  const root = map.querySelector<HTMLDetailsElement>("[data-captured-route-entries]");
  if (!root) throw new Error("Selected route detail missing");
  open(root);
  const more = root.querySelector("button"),
    detail = root.querySelector<HTMLDetailsElement>("li details");
  map.querySelector<HTMLButtonElement>('[data-record-index="1"]')?.click();
  expect(map.contains(root)).toBe(false);
  more?.click();
  if (detail) open(detail);
  expect(root.querySelectorAll("[data-route-index]")).toHaveLength(12);
  expect(detail?.querySelector("pre")).toBeNull();
  map.querySelector<HTMLButtonElement>('[data-record-index="0"]')?.click();
  expect(map.querySelector("[data-captured-route-entries] li")).toBeNull();
  let current = false;
  const held = mount(r, () => current);
  open(held);
  expect(held.querySelector("li")).toBeNull();
  current = true;
  open(held);
  expect(held.querySelectorAll("[data-route-index]")).toHaveLength(12);
});

it("keeps unsupported resource kinds out and renders provider strings as inert literal text", () => {
  expect(renderCapturedRouteRecords(resource("nat_gateway"), context, () => true)).toBeUndefined();
  const value = resource();
  value.routes = [{ ...route(), state: "<img src=x>", targets: { "<script>": "<img src=x>" } }];
  const root = mount(value);
  open(root);
  expect(root.textContent).toContain("<script>");
  expect(root.textContent).toContain("<img src=x>");
  expect(root.querySelectorAll("img,script,a,form,input,select")).toHaveLength(0);
  expect(raw(root)).toEqual(value.routes[0]);
});

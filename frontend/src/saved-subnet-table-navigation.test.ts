import { afterEach, expect, it, vi } from "vitest";
import { renderAwsTopology } from "./aws-view";
import type { AwsResource, TopologyView } from "./generated";

afterEach(() => document.body.replaceChildren());
function record(id: string, kind: AwsResource["kind"]): AwsResource {
  return {
    id,
    kind,
    owner_account_id: "123456789012",
    vpc_id: "vpc-source",
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
  };
}
function fixture(): TopologyView {
  const source = record("subnet-source", "subnet"),
    target = record("rtb-target", "route_table");
  target.routes = [
    {
      ipv4_destination: "0.0.0.0/0",
      ipv6_destination: null,
      prefix_list_destination: null,
      state: "blackhole",
      origin: "reported-origin",
      targets: { transitGatewayId: "unvalidated-tgw" },
    },
  ];
  return {
    topology: {
      id: "capture",
      account_id: "registration",
      aws_account_id: "123456789012",
      region: "eu-west-1",
      started_at: "original-start",
      completed_at: "original-end",
      session_name: "fixture",
      resources: [source, ...Array.from({ length: 49 }, (_, i) => record(`rtb-${i}`, "route_table")), target],
      request_ids: [],
      complete_for_supported_queries: true,
      limitations: [],
      execution_enabled: false,
      connectivity_tested: false,
    },
    adoptions: [],
    subnet_route_tables: [
      {
        subnet_id: source.id,
        vpc_id: source.vpc_id,
        selection: { status: "selected", route_table_id: target.id, source: "implicit_main" },
      },
    ],
  };
}
function mount(view: TopologyView, current = () => true) {
  const consent = vi.fn(async () => {}),
    lookup = vi.fn(async () => undefined);
  const root = renderAwsTopology(view, {
    canConsent: false,
    onConsent: consent,
    onVpcLookup: lookup,
    isCurrent: current,
  });
  document.body.append(root);
  const map = root.querySelector<HTMLElement>('[aria-label="Saved AWS resource map"]');
  if (!map) throw new Error("Missing map");
  return { map, consent, lookup };
}
function button(map: HTMLElement, name: string) {
  return [...map.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name);
}
function filter(map: HTMLElement, kind: string, query: string) {
  const select = map.querySelector<HTMLSelectElement>("select");
  if (!select) throw new Error("Missing kind");
  select.value = kind;
  select.dispatchEvent(new Event("change"));
  const input = map.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("Missing search");
  input.value = query;
  input.dispatchEvent(new Event("input"));
}
function original(map: HTMLElement) {
  const detail = [...map.querySelectorAll<HTMLDetailsElement>("aside details")].find(
    (d) => d.querySelector("summary")?.textContent === "Original captured record",
  );
  if (!detail) throw new Error("Missing original");
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
  return JSON.parse(detail.querySelector("pre")?.textContent ?? "null");
}
it("navigates from the original subnet to its calculated captured table in a bounded batch and restores the source context", () => {
  const view = fixture(),
    before = structuredClone(view),
    { map, consent, lookup } = mount(view);
  filter(map, "subnet", "source");
  expect(original(map)).toEqual(view.topology.resources[0]);
  const open = button(map, "Inspect calculated table record");
  expect(open).toBeDefined();
  expect(open?.disabled).toBe(false);
  open?.click();
  expect(original(map)).toEqual(view.topology.resources[50]);
  expect(map.querySelector('[data-record-index="50"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(map.querySelectorAll("button[data-record-index]").length).toBeLessThanOrEqual(24);
  expect(map.querySelector("aside [data-captured-route-entries]")).not.toBeNull();
  expect(map.querySelector<HTMLSelectElement>("select")?.value).toBe("route_table");
  expect(map.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
  const back = button(map, "Return to source subnet");
  expect(back).toBeDefined();
  back?.click();
  expect(original(map)).toEqual(view.topology.resources[0]);
  expect(map.querySelector<HTMLSelectElement>("select")?.value).toBe("subnet");
  expect(map.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("source");
  expect(map.querySelector('[data-record-index="0"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(consent).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(view).toEqual(before);
});

it("keeps earlier captured table batches reachable after following a target beyond the first batch", () => {
  const view = fixture(),
    before = structuredClone(view),
    { map } = mount(view);
  filter(map, "subnet", "source");
  button(map, "Inspect calculated table record")?.click();
  expect(map.querySelector('[data-record-index="50"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(map.textContent).toContain("Filtered positions 49–50");
  const earlier = button(map, "Show earlier captured records");
  expect(earlier).toBeDefined();
  earlier?.click();
  expect(map.querySelectorAll("button[data-record-index]")).toHaveLength(24);
  expect(button(map, "Return to source subnet")).toBeUndefined();
  button(map, "Show earlier captured records")?.click();
  button(map, "Show more captured records")?.click();
  button(map, "Show more captured records")?.click();
  expect(
    [...map.querySelectorAll<HTMLElement>("[data-record-index]")].map((node) =>
      Number(node.dataset.recordIndex),
    ),
  ).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  expect(view).toEqual(before);
});

it("refuses ambiguous or changed associations and retained controls without replacing the original selected evidence", () => {
  const corruptions: ((view: TopologyView) => void)[] = [
    (v) => {
      v.topology.resources.pop();
    },
    (v) => {
      v.topology.resources.push(structuredClone(v.topology.resources[50]));
    },
    (v) => {
      v.topology.resources.push(record("rtb-target", "nat_gateway"));
    },
    (v) => {
      v.topology.resources[50].vpc_id = "wrong-vpc";
    },
    (v) => {
      v.topology.resources[50].kind = "transit_gateway_route_table";
    },
    (v) => {
      v.topology.resources[0].vpc_id = null;
      v.topology.resources[50].vpc_id = null;
      v.subnet_route_tables[0].vpc_id = null;
    },
    (v) => {
      v.topology.resources.push(record("subnet-source", "nat_gateway"));
    },
    (v) => {
      v.subnet_route_tables.push(structuredClone(v.subnet_route_tables[0]));
    },
    (v) => {
      v.subnet_route_tables[0].selection = { status: "unresolved", reason: "missing_route_table" };
    },
  ];
  for (const corrupt of corruptions) {
    const view = fixture();
    corrupt(view);
    const { map, consent, lookup } = mount(view);
    filter(map, "subnet", "source");
    const before = original(map),
      open = button(map, "Inspect calculated table record");
    expect(!open || open.disabled).toBe(true);
    open?.click();
    expect(original(map)).toEqual(before);
    expect(consent).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    document.body.replaceChildren();
  }
  const mutations: ((view: TopologyView) => void)[] = [
    ...corruptions,
    (v) => {
      v.topology.resources = [...v.topology.resources];
    },
    (v) => {
      v.subnet_route_tables = [...v.subnet_route_tables];
    },
    (v) => {
      v.topology.resources[50] = structuredClone(v.topology.resources[50]);
    },
    (v) => {
      v.topology.resources[0] = structuredClone(v.topology.resources[0]);
    },
    (v) => {
      v.subnet_route_tables[0] = structuredClone(v.subnet_route_tables[0]);
    },
    (v) => {
      v.topology.id = "different-capture";
    },
    (v) => {
      v.topology.completed_at = "later";
    },
    (v) => {
      v.topology.account_id = "another-registration";
    },
    (v) => {
      v.topology.connectivity_tested = true;
    },
    (v) => {
      v.topology.resources[50].routes[0].state = "changed-after-render";
    },
  ];
  for (const mutate of mutations) {
    const view = fixture(),
      { map } = mount(view);
    filter(map, "subnet", "source");
    const before = original(map),
      open = button(map, "Inspect calculated table record");
    expect(open?.disabled).toBe(false);
    mutate(view);
    open?.click();
    expect(original(map)).toEqual(before);
    expect(button(map, "Return to source subnet")).toBeUndefined();
    document.body.replaceChildren();
  }
  for (const boundary of ["disabled", "removed", "moved", "retired", "owner", "disconnected"]) {
    const view = fixture();
    let current = true;
    const { map } = mount(view, () => current);
    filter(map, "subnet", "source");
    const open = button(map, "Inspect calculated table record");
    if (!open) throw new Error("Missing positive action");
    const before = original(map);
    if (boundary === "disabled") open.disabled = true;
    if (boundary === "removed") open.remove();
    if (boundary === "moved") map.append(open);
    if (boundary === "retired") {
      filter(map, "subnet", "subnet-source");
      map.querySelector("aside [data-captured-subnet-table]")?.append(open);
    }
    if (boundary === "owner") current = false;
    if (boundary === "disconnected") map.remove();
    open.onclick?.call(open, new PointerEvent("click"));
    expect(original(map)).toEqual(before);
    document.body.replaceChildren();
  }
  for (const boundary of [
    "disabled",
    "removed",
    "moved",
    "changed",
    "owner",
    "disconnected",
    "new-selection",
  ]) {
    const view = fixture();
    let current = true;
    const { map } = mount(view, () => current);
    filter(map, "subnet", "source");
    button(map, "Inspect calculated table record")?.click();
    const back = button(map, "Return to source subnet");
    if (!back) throw new Error("Missing positive return");
    const before = original(map);
    if (boundary === "disabled") back.disabled = true;
    if (boundary === "removed") back.remove();
    if (boundary === "moved") map.append(back);
    if (boundary === "changed") view.topology.resources[50].routes[0].state = "changed";
    if (boundary === "owner") current = false;
    if (boundary === "disconnected") map.remove();
    if (boundary === "new-selection") {
      filter(map, "route_table", "rtb-0");
      const selected = original(map);
      map.querySelector("aside")?.append(back);
      back.onclick?.call(back, new PointerEvent("click"));
      expect(original(map)).toEqual(selected);
    } else {
      back.onclick?.call(back, new PointerEvent("click"));
      expect(original(map)).toEqual(before);
    }
    document.body.replaceChildren();
  }
});

it.each(["inspect", "return"])(
  "pins the source position before %s when original records reorder in place",
  (phase) => {
    const view = fixture(),
      resources = view.topology.resources,
      source = resources[0],
      target = resources[50];
    const other = record("subnet-second", "subnet"),
      row = view.subnet_route_tables[0];
    resources.push(other);
    const unchangedEvidence = JSON.stringify([source, target, row]),
      { map } = mount(view);
    filter(map, "subnet", "subnet-");
    expect(map.querySelectorAll("button[data-record-index]")).toHaveLength(2);
    expect(map.querySelector('[data-record-index="0"]')?.getAttribute("aria-pressed")).toBe("true");
    const inspect = button(map, "Inspect calculated table record");
    expect(inspect?.disabled).toBe(false);
    if (phase === "return") {
      inspect?.click();
      expect(map.querySelector('[data-record-index="50"]')?.getAttribute("aria-pressed")).toBe("true");
    }
    const before = original(map),
      action = phase === "inspect" ? inspect : button(map, "Return to source subnet");
    expect(action?.disabled).toBe(false);
    resources[0] = other;
    resources[resources.length - 1] = source;
    expect(view.topology.resources).toBe(resources);
    expect(resources[50]).toBe(target);
    expect(JSON.stringify([source, target, row])).toBe(unchangedEvidence);
    expect(resources[0].id).not.toBe(source.id);
    action?.click();
    expect(original(map)).toEqual(before);
  },
);

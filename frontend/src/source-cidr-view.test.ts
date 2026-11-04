import { expect, it, vi } from "vitest";
import { renderAwsTopology } from "./aws-view";
import type { AwsResource, SavedObservation, SourceHandoffCidrCoverage } from "./generated";
import { validateSourceCidr } from "./source-cidr-contract";
import { captureSourceCidrContext } from "./source-cidr-view";
import { renderSourceHandoff } from "./source-handoff-view";

function saved(id: string): SavedObservation {
  return {
    registration: {
      id,
      name: id,
      role_arn: "role",
      aws_account_id: `aws-${id}`,
      region: "region",
      verified_at: "1",
      verified_session_name: "verified",
      execution_enabled: false,
    },
    saved_row_id: `snapshot-${id}`,
    generation: 1,
    admitted_bytes: 0,
    topology: {
      id: `snapshot-${id}`,
      account_id: id,
      aws_account_id: `aws-${id}`,
      region: "region",
      started_at: "1",
      completed_at: id === "source" ? "2" : "4",
      session_name: "scan",
      resources: [],
      request_ids: ["request"],
      complete_for_supported_queries: true,
      limitations: ["<img src=x>"],
      execution_enabled: false,
      connectivity_tested: false,
    },
  };
}
function resource(): AwsResource {
  return {
    kind: "route_table",
    id: "rtb",
    owner_account_id: null,
    vpc_id: null,
    subnet_id: null,
    az_id: null,
    state: null,
    cidrs: [],
    public_ips: [],
    private_ips: [],
    tags: { future: "<img src=x>" },
    routes: [
      {
        ipv4_destination: "0.0.0.0/0",
        ipv6_destination: null,
        prefix_list_destination: null,
        state: "future",
        origin: "future",
        targets: { future: "literal" },
      },
    ],
    associations: [{ state: null, id: null, subnet_id: null, gateway_id: null, main: false }],
    tgw_associations: [
      {
        attachment_id: null,
        resource_id: null,
        resource_type: "future",
        state: null,
        route_table_announcement_id: null,
      },
    ],
    tgw_propagations: [],
    tgw_routes: [
      {
        destination_cidr: "0.0.0.0/0",
        prefix_list_id: null,
        state: "future",
        route_type: "future",
        route_table_announcement_id: null,
        attachments: [{ attachment_id: null, resource_id: null, resource_type: null }],
      },
    ],
    related_ids: [],
    connectivity_type: null,
    availability_mode: null,
    nat_gateway: {
      route_table_id: null,
      addresses: [
        {
          allocation_id: null,
          association_id: null,
          network_interface_id: null,
          public_ip: null,
          private_ip: null,
          az_name: null,
          az_id: null,
          is_primary: null,
          status: "future",
        },
      ],
    },
    managed: false,
  };
}
function response(): SourceHandoffCidrCoverage {
  return {
    query: {
      source_account_id: "source",
      network_account_id: "network",
      subnet_id: "subnet",
      destination_cidr: "203.0.113.0/29",
    },
    source_saved: saved("source"),
    network_saved: saved("network"),
    origins: [{ cut_index: 0, predicate: { kind: "query" }, edge: "query_start", clipped: false }],
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
    reference_only: true,
    partition_complete: true,
    execution_enabled: false,
    connectivity_tested: false,
    simultaneous_snapshots: false,
  };
}
function setup(
  lookup = vi.fn(async (): Promise<SourceHandoffCidrCoverage | undefined> => response()),
  current = () => true,
) {
  const source = saved("source").topology;
  const form = renderSourceHandoff(
    source.id,
    "subnet",
    { status: "unresolved", reason: "missing_route_table" },
    0,
    [saved("network").registration],
    vi.fn(async () => undefined),
    undefined,
    { lookupCidr: lookup, sourceCidr: source, isCurrent: current },
  );
  document.body.replaceChildren(form);
  const network = required(form.querySelector("select"));
  network.value = "network";
  const detail = required(form.querySelector<HTMLDetailsElement>("[data-source-cidr]"));
  return { form, network, detail, lookup, source };
}
function open(detail: HTMLDetailsElement) {
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
}
function controls(detail: HTMLDetailsElement) {
  return { input: required(detail.querySelector("input")), button: required(detail.querySelector("button")) };
}
async function accept(detail: HTMLDetailsElement) {
  open(detail);
  const { input, button } = controls(detail);
  input.value = "203.0.113.0/29";
  button.click();
  await expect.poll(() => detail.querySelector("[data-source-cidr-summary]")).not.toBeNull();
}
it("provides one independent collapsed lazy CIDR action without parent native validity or point submission", async () => {
  const { form, detail, lookup } = setup();
  expect(detail).not.toBeNull();
  expect(detail.open).toBe(false);
  expect(detail.querySelector("input")).toBeNull();
  await accept(detail);
  expect(required(form.querySelector("input")).value).toBe("");
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    network_account_id: "network",
    subnet_id: "subnet",
    destination_cidr: "203.0.113.0/29",
  });
  expect(detail.textContent).toContain("not a validated path");
  expect(detail.querySelectorAll("[data-source-cidr-interval]")).toHaveLength(0);
  open(required(detail.querySelector<HTMLDetailsElement>("[data-source-cidr-intervals]")));
  expect(detail.querySelectorAll("[data-source-cidr-interval]")).toHaveLength(1);
  expect(required(detail.querySelector("[data-source-cidr-interval]")).textContent).toContain("203.0.113.7");
  expect(controls(detail).input.required).toBe(false);
  expect(detail.querySelector("form")).toBeNull();
  required(form.querySelector("input")).value = "203.0.113.1";
  expect(form.checkValidity()).toBe(true);
});
it.each([
  [
    "final interval",
    (v: SourceHandoffCidrCoverage) => {
      v.segments.push({ ...required(v.segments[0]), end_inclusive: "" });
    },
  ],
  [
    "omitted false",
    (v: SourceHandoffCidrCoverage) => {
      Reflect.deleteProperty(v, "simultaneous_snapshots");
    },
  ],
  [
    "unsafe generation",
    (v: SourceHandoffCidrCoverage) => {
      v.network_saved.generation = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "unsafe admitted bytes",
    (v: SourceHandoffCidrCoverage) => {
      v.source_saved.admitted_bytes = -1;
    },
  ],
  [
    "source provenance",
    (v: SourceHandoffCidrCoverage) => {
      v.source_saved.topology.request_ids.push("other");
    },
  ],
  [
    "network registration region",
    (v: SourceHandoffCidrCoverage) => {
      v.network_saved.registration.region = v.network_saved.topology.region = "other";
    },
  ],
  [
    "network row",
    (v: SourceHandoffCidrCoverage) => {
      v.network_saved.saved_row_id = "other";
    },
  ],
  [
    "extra query field",
    (v: SourceHandoffCidrCoverage) => {
      Object.assign(v.query, { extra: "bad" });
    },
  ],
  [
    "sparse resource tail",
    (v: SourceHandoffCidrCoverage) => {
      v.source_saved.topology.resources.length = 1;
    },
  ],
  [
    "sparse tuple tail",
    (v: SourceHandoffCidrCoverage) => {
      const r = resource();
      required(required(r.nat_gateway).addresses).length = 2;
      v.source_saved.topology.resources.push(r);
    },
  ],
  [
    "final resource",
    (v: SourceHandoffCidrCoverage) => {
      const r = resource();
      Reflect.deleteProperty(r, "managed");
      v.network_saved.topology.resources.push(r);
    },
  ],
  [
    "final tuple",
    (v: SourceHandoffCidrCoverage) => {
      const r = resource();
      Reflect.deleteProperty(required(required(required(r.nat_gateway).addresses)[0]), "is_primary");
      v.source_saved.topology.resources.push(r);
    },
  ],
  [
    "final attachment",
    (v: SourceHandoffCidrCoverage) => {
      const r = resource();
      Reflect.deleteProperty(required(required(required(r.tgw_routes)[0]).attachments[0]), "resource_id");
      v.source_saved.topology.resources.push(r);
    },
  ],
  [
    "origin wrong row kind",
    (v: SourceHandoffCidrCoverage) => {
      v.source_saved.topology.resources.push({ ...resource(), kind: "subnet" });
      v.origins.push({
        cut_index: 0,
        predicate: { kind: "source_vpc_route", resource_index: 0, route_index: 0 },
        edge: "enter",
        clipped: true,
      });
    },
  ],
  [
    "origin unsafe index",
    (v: SourceHandoffCidrCoverage) => {
      v.origins.push({
        cut_index: Number.MAX_SAFE_INTEGER + 1,
        predicate: { kind: "vpc_service", policy_index: 0 },
        edge: "enter",
        clipped: false,
      });
    },
  ],
  [
    "origin policy index",
    (v: SourceHandoffCidrCoverage) => {
      v.origins.push({
        cut_index: 0,
        predicate: { kind: "vpc_service", policy_index: 2 },
        edge: "enter",
        clipped: false,
      });
    },
  ],
  [
    "origin clipped leave",
    (v: SourceHandoffCidrCoverage) => {
      v.origins.push({
        cut_index: 0,
        predicate: { kind: "vpc_service", policy_index: 0 },
        edge: "leave",
        clipped: true,
      });
    },
  ],
  [
    "duplicate query origin",
    (v: SourceHandoffCidrCoverage) => {
      v.origins.push(required(v.origins[0]));
    },
  ],
] as const)("rejects %s atomically before any successful summary", async (_label, mutate) => {
  const value = response();
  mutate(value);
  const { detail } = setup(vi.fn(async () => value));
  open(detail);
  const { input, button } = controls(detail);
  input.value = "203.0.113.0/29";
  button.click();
  await expect.poll(() => button.disabled).toBe(false);
  expect(detail.querySelector("[data-source-cidr-summary]")).toBeNull();
  expect(detail.querySelector("[data-source-cidr-intervals]")).toBeNull();
  expect(detail.textContent).toContain("did not match");
});
it("lazily traverses 101 intervals, origins, resources and nested metadata in complete local batches and owns accepted data once", async () => {
  const value = response();
  value.segments = Array.from({ length: 101 }, (_, index) => ({
    ...structuredClone(required(value.segments[0])),
    start: `start-${index}`,
    end_inclusive: `end-${index}`,
  }));
  Object.assign(required(value.segments[100]).result.source, { reason: "<img src=x>" });
  value.origins.push(
    ...Array.from({ length: 100 }, () => ({
      cut_index: 0,
      predicate: { kind: "vpc_service" as const, policy_index: 0 },
      edge: "enter" as const,
      clipped: false,
    })),
  );
  const r = resource();
  r.routes = Array.from({ length: 101 }, () => structuredClone(required(r.routes[0])));
  value.source_saved.topology.resources = Array.from({ length: 101 }, () => structuredClone(r));
  const { detail } = setup(vi.fn(async () => value));
  await accept(detail);
  required(value.segments[100]).end_inclusive = "mutated";
  required(required(value.source_saved.topology.resources[0]).routes[100]).state = "mutated";
  const intervals = required(detail.querySelector<HTMLDetailsElement>("[data-source-cidr-intervals]"));
  open(intervals);
  expect(intervals.querySelectorAll("[data-source-cidr-interval]")).toHaveLength(50);
  const more = required(intervals.querySelector<HTMLButtonElement>(":scope > button"));
  more.click();
  expect(intervals.querySelectorAll("[data-source-cidr-interval]")).toHaveLength(100);
  more.click();
  open(intervals);
  expect(intervals.querySelectorAll("[data-source-cidr-interval]")).toHaveLength(101);
  expect(intervals.textContent).toContain("end-100");
  expect(intervals.textContent).not.toContain("mutated");
  const origins = required(
    detail.querySelector<HTMLDetailsElement>('[data-source-cidr-evidence="Cut origins"]'),
  );
  open(origins);
  required(origins.querySelector<HTMLButtonElement>(":scope > button")).click();
  required(origins.querySelector<HTMLButtonElement>(":scope > button")).click();
  expect(origins.querySelectorAll(":scope > ul > li")).toHaveLength(101);
  const resources = required(
    detail.querySelector<HTMLDetailsElement>('[data-source-cidr-evidence="Source resources"]'),
  );
  open(resources);
  required(resources.querySelector<HTMLButtonElement>(":scope > button")).click();
  required(resources.querySelector<HTMLButtonElement>(":scope > button")).click();
  expect(resources.querySelectorAll(":scope > ul > li")).toHaveLength(101);
  const first = required(resources.querySelector<HTMLDetailsElement>("li > details"));
  open(first);
  const routes = required(first.querySelector<HTMLDetailsElement>('[data-source-cidr-evidence="routes"]'));
  open(routes);
  required(routes.querySelector<HTMLButtonElement>(":scope > button")).click();
  required(routes.querySelector<HTMLButtonElement>(":scope > button")).click();
  expect(routes.querySelectorAll(":scope > ul > li")).toHaveLength(101);
  const last = required(routes.querySelectorAll<HTMLDetailsElement>(":scope > ul > li > details")[100]);
  open(last);
  expect(last.textContent).toContain('"future"');
  expect(last.textContent).not.toContain("mutated");
  expect(detail.querySelector("img,a")).toBeNull();
});
function defer<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((done) => setTimeout(done, 0));
it.each(["success", "error", "discard"])(
  "an ignored-abort old %s/finally cannot alter a newer pending CIDR read after child/parent/network ABA or identical/invalid parent submit",
  async (outcome) => {
    for (const change of [
      "childABA",
      "parentABA",
      "networkABA",
      "identicalSubmit",
      "invalidEventlessSubmit",
    ]) {
      const old = defer<SourceHandoffCidrCoverage | undefined>(),
        next = defer<SourceHandoffCidrCoverage | undefined>();
      const lookup = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      const { form, detail, network } = setup(lookup);
      open(detail);
      const { input, button } = controls(detail),
        point = required(form.querySelector("input"));
      input.value = "203.0.113.0/29";
      button.click();
      button.click();
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(point.disabled).toBe(false);
      expect(network.disabled).toBe(false);
      if (change === "childABA" || change === "parentABA" || change === "networkABA") {
        const field = change === "childABA" ? input : change === "parentABA" ? point : network;
        const original = field.value;
        field.value = "other";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.value = original;
        field.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        if (change === "invalidEventlessSubmit") network.value = "";
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        network.value = "network";
      }
      expect(button.disabled).toBe(false);
      button.click();
      const reading = required(detail.querySelector("[role=status]")).textContent;
      if (outcome === "error") old.reject(new Error("obsolete error"));
      else old.resolve(outcome === "success" ? response() : undefined);
      await flush();
      expect(required(detail.querySelector("[role=status]")).textContent).toBe(reading);
      expect(button.disabled).toBe(true);
      expect(input.disabled).toBe(true);
      expect(detail.querySelector("[data-source-cidr-summary]")).toBeNull();
      next.resolve(response());
      await expect.poll(() => detail.querySelector("[data-source-cidr-summary]")).not.toBeNull();
      expect(button.disabled).toBe(false);
      expect(input.disabled).toBe(false);
    }
  },
);
it("eventless completion mismatch restores only child controls with rerun guidance and a current discard/error remains retryable", async () => {
  for (const eventless of ["child", "point", "network"]) {
    const pending = defer<SourceHandoffCidrCoverage | undefined>();
    const lookup = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("current failure"))
      .mockResolvedValueOnce(response());
    const { form, detail, network } = setup(lookup);
    open(detail);
    const { input, button } = controls(detail),
      point = required(form.querySelector("input"));
    input.value = "203.0.113.0/29";
    button.click();
    (eventless === "child" ? input : eventless === "point" ? point : network).value = "changed";
    pending.resolve(response());
    await flush();
    expect(button.disabled).toBe(false);
    expect(detail.textContent).toContain("run another");
    expect(detail.querySelector("[data-source-cidr-summary]")).toBeNull();
    input.value = "203.0.113.0/29";
    network.value = "network";
    button.click();
    await flush();
    expect(detail.textContent).toContain("discarded");
    button.click();
    await flush();
    expect(detail.textContent).toContain("current failure");
    button.click();
    await expect.poll(() => detail.querySelector("[data-source-cidr-summary]")).not.toBeNull();
  }
});
it.each(["", "x".repeat(65)])(
  "eventless invalid explicit retry %j atomically retires accepted rows and retained lazy controls without changing parent evidence",
  async (invalid) => {
    const { form, detail, lookup } = setup();
    const unrelated = document.createElement("p");
    unrelated.textContent = "Unrelated parent evidence";
    form.append(unrelated);
    await accept(detail);
    const retained = required(detail.querySelector<HTMLDetailsElement>("[data-source-cidr-intervals]"));
    const { input, button } = controls(detail);
    input.value = invalid;
    button.click();
    expect(detail.querySelector("[data-source-cidr-summary]")).toBeNull();
    open(retained);
    expect(retained.querySelector("[data-source-cidr-interval]")).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(unrelated.textContent).toBe("Unrelated parent evidence");
    expect(form.contains(unrelated)).toBe(true);
  },
);
it("child Enter is canceled and opening/reopening never fetches or duplicates controls", () => {
  const { detail, form, lookup } = setup();
  open(detail);
  open(detail);
  const { input } = controls(detail);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  expect(detail.querySelectorAll("input")).toHaveLength(1);
  expect(form.querySelectorAll("form")).toHaveLength(0);
  expect(lookup).not.toHaveBeenCalled();
});
it("wires optional CIDR sibling controls through topology and retires retained source cards on same-view paging", async () => {
  const source = saved("source").topology;
  source.resources = Array.from({ length: 201 }, (_, i) => ({
    ...resource(),
    kind: "subnet" as const,
    id: `subnet-${i}`,
  }));
  const view = {
    topology: source,
    adoptions: [],
    subnet_route_tables: [
      {
        subnet_id: "subnet-0",
        vpc_id: null,
        selection: { status: "unresolved" as const, reason: "missing_route_table" as const },
      },
    ],
  };
  const lookup = vi.fn(async () => {
    const value = response();
    value.query.subnet_id = "subnet-0";
    return value;
  });
  const root = renderAwsTopology(view, {
    canConsent: false,
    onConsent: async () => {},
    onSourceLookup: async () => undefined,
    onSourceCidrCoverage: lookup,
    networkAccounts: [saved("network").registration],
  });
  const parent = required(
    [...root.querySelectorAll<HTMLDetailsElement>("details")].find(
      (d) => d.querySelector(":scope > summary")?.textContent === "Inspect saved source-to-TGW candidate",
    ),
  );
  open(parent);
  const form = required(parent.querySelector("form"));
  const child = required(form.querySelector<HTMLDetailsElement>("[data-source-cidr]"));
  expect(child).not.toBeNull();
  expect(child.querySelector("input")).toBeNull();
  required(form.querySelector("select")).value = "network";
  open(child);
  const old = controls(child);
  await accept(child);
  const retained = required(child.querySelector<HTMLDetailsElement>("[data-source-cidr-intervals]"));
  required(
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Show more observed records"),
  ).click();
  expect(root.contains(child)).toBe(false);
  old.input.value = "203.0.113.0/29";
  old.button.click();
  open(retained);
  expect(retained.querySelector("[data-source-cidr-interval]")).toBeNull();
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("validates every required saved/resource/nested field and explicit false marker rather than accepting an omitted malformed tail", () => {
  const complete = response();
  complete.source_saved.topology.resources = [resource()];
  complete.network_saved.topology.resources = [{ ...resource(), kind: "transit_gateway_route_table" }];
  complete.origins.push(
    {
      cut_index: 0,
      predicate: { kind: "source_vpc_route", resource_index: 0, route_index: 0 },
      edge: "enter",
      clipped: true,
    },
    {
      cut_index: 0,
      predicate: { kind: "network_tgw_route", resource_index: 0, route_index: 0 },
      edge: "enter",
      clipped: false,
    },
  );
  const validate = (value: SourceHandoffCidrCoverage) =>
    validateSourceCidr(value, saved("source").topology, saved("network").registration, response().query);
  expect(() => validate(complete)).not.toThrow();
  for (const side of ["source_saved", "network_saved"] as const) {
    const paths = [
      [],
      ["registration"],
      ["topology"],
      ["topology", "resources", "0"],
      ["topology", "resources", "0", "routes", "0"],
      ["topology", "resources", "0", "associations", "0"],
      ["topology", "resources", "0", "tgw_associations", "0"],
      ["topology", "resources", "0", "tgw_routes", "0"],
      ["topology", "resources", "0", "tgw_routes", "0", "attachments", "0"],
      ["topology", "resources", "0", "nat_gateway"],
      ["topology", "resources", "0", "nat_gateway", "addresses", "0"],
    ];
    for (const path of paths) {
      const at = (value: SourceHandoffCidrCoverage): Record<string, unknown> =>
        path.reduce(
          (object, key) => required(object[key]) as Record<string, unknown>,
          value[side] as unknown as Record<string, unknown>,
        );
      for (const key of Object.keys(at(complete))) {
        const malformed = structuredClone(complete);
        Reflect.deleteProperty(at(malformed), key);
        expect(() => validate(malformed), `${side}.${path.join(".")}.${key}`).toThrow("did not match");
      }
    }
  }
  for (const marker of [
    "execution_enabled",
    "connectivity_tested",
    "simultaneous_snapshots",
    "reference_only",
    "partition_complete",
  ]) {
    const malformed = structuredClone(complete);
    Reflect.deleteProperty(malformed, marker);
    expect(() => validate(malformed)).toThrow("did not match");
  }
});
it("binds a candidate to the source TGW ID while retaining literal future reasons and independent network capture metadata", async () => {
  const value = response();
  required(value.segments[0]).result = {
    source: {
      status: "reported",
      route_table_id: "rtb",
      source: "explicit_subnet",
      lookup: {
        status: "reported_route",
        destination_cidr: "0.0.0.0/0",
        origin: "future-origin",
        target: { kind: "transit_gateway", id: "tgw" },
      },
    },
    handoff: {
      status: "reported_candidate",
      transit_gateway_id: "tgw",
      ingress_attachment_id: "attachment",
      attachment_subnet_id: "subnet",
      az_id: "az",
      route_table_id: "table",
      lookup: {
        status: "reported_forward",
        destination_cidr: "0.0.0.0/0",
        route_type: "future-type",
        attachment_ids: ["duplicate", "duplicate"],
      },
    },
  };
  const validate = () =>
    validateSourceCidr(value, saved("source").topology, saved("network").registration, response().query);
  expect(validate).not.toThrow();
  const handoff = required(value.segments[0]).result.handoff;
  if (handoff.status !== "reported_candidate") throw new Error("Missing fixture");
  handoff.transit_gateway_id = "other";
  expect(validate).toThrow("did not match");
  handoff.transit_gateway_id = "tgw";
  Object.assign(required(value.segments[0]).result, {
    source: { status: "unresolved", reason: "<img src=x> future source" },
    handoff: { status: "ingress_unresolved", reason: "<img src=x> future ingress" },
  });
  value.network_saved.topology.started_at = "200";
  value.network_saved.topology.completed_at = "100";
  value.network_saved.topology.request_ids = ["independent", "independent"];
  const { detail } = setup(vi.fn(async () => value));
  await accept(detail);
  open(required(detail.querySelector<HTMLDetailsElement>("[data-source-cidr-intervals]")));
  const decision = required(
    detail.querySelector<HTMLDetailsElement>('[data-source-cidr-evidence="Saved decision"]'),
  );
  open(decision);
  for (const result of decision.querySelectorAll<HTMLDetailsElement>(":scope > ul > li > details"))
    open(result);
  expect(decision.textContent).toContain("future source");
  expect(decision.textContent).toContain("future ingress");
  expect(detail.querySelector("img,a")).toBeNull();
});
it("captures only immutable source-page metadata, never source resources", () => {
  const source = saved("source").topology;
  const snapshot = captureSourceCidrContext(source);
  source.request_ids.push("changed");
  source.limitations.push("changed");
  source.id = "changed";
  expect(snapshot.id).toBe("snapshot-source");
  expect(snapshot.request_ids).toEqual(["request"]);
  expect(snapshot.limitations).toEqual(["<img src=x>"]);
  expect(Object.hasOwn(snapshot, "resources")).toBe(false);
});
it("retained child controls detached from their parent refuse reads even if the outer epoch is unchanged", () => {
  const { detail, lookup } = setup();
  open(detail);
  const { input, button } = controls(detail);
  detail.remove();
  input.value = "203.0.113.0/29";
  button.click();
  expect(lookup).not.toHaveBeenCalled();
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test fixture/control");
  return value;
}

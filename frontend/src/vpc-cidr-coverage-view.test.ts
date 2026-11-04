import { afterEach, describe, expect, it, vi } from "vitest";
import type { AwsResource, TopologyView, VpcCidrCoverageResponse, VpcLookupReason } from "./generated";
import { renderVpcCidrCoverage, type SavedVpcCidrCoverage } from "./vpc-cidr-coverage-view";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture evidence");
  return value;
}
function fixture() {
  const base: AwsResource = {
    kind: "vpc",
    id: "vpc-a",
    owner_account_id: "123456789012",
    vpc_id: null,
    subnet_id: null,
    az_id: null,
    state: "available",
    cidrs: [],
    public_ips: [],
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
  const table: AwsResource = {
    ...base,
    kind: "route_table",
    id: "rtb-a",
    vpc_id: "vpc-a",
    routes: [
      {
        ipv4_destination: "10.0.0.0/16",
        ipv6_destination: null,
        prefix_list_destination: null,
        state: "active",
        origin: "CreateRoute",
        targets: { gatewayId: "local" },
      },
    ],
    associations: [{ id: "association", state: "associated", main: true, subnet_id: null, gateway_id: null }],
  };
  const view: TopologyView = {
    topology: {
      id: "snapshot",
      account_id: "registration",
      aws_account_id: "123456789012",
      region: "eu-west-1",
      started_at: "1",
      completed_at: "2",
      session_name: "offline",
      resources: [base, { ...base, kind: "subnet", id: "subnet-a", vpc_id: "vpc-a" }, table],
      request_ids: ["request-a"],
      limitations: ["<img src=x> is not interpreted"],
      complete_for_supported_queries: true,
      execution_enabled: false,
      connectivity_tested: false,
    },
    adoptions: [],
    subnet_route_tables: [
      {
        subnet_id: "subnet-a",
        vpc_id: "vpc-a",
        selection: { status: "selected", route_table_id: "rtb-a", source: "implicit_main" },
      },
    ],
  };
  const value: VpcCidrCoverageResponse = {
    account_id: "registration",
    topology_id: "snapshot",
    completed_at: "2",
    aws_account_id: "123456789012",
    region: "eu-west-1",
    subnet_id: "subnet-a",
    destination_cidr: "10.0.0.0/16",
    complete_for_supported_queries: true,
    limitations: [...view.topology.limitations],
    request_ids: ["request-a"],
    reference_only: true,
    execution_enabled: false,
    connectivity_tested: false,
    coverage: {
      destination_cidr: "10.0.0.0/16",
      partition_complete: true,
      table_evidence: {
        route_table_resource_index: 2,
        route_table_id: "rtb-a",
        source: "implicit_main",
        original_table: structuredClone(table),
      },
      segments: [
        {
          start: "10.0.0.0",
          end_inclusive: "10.0.255.255",
          result: {
            status: "reported",
            route_table_id: "rtb-a",
            source: "implicit_main",
            lookup: {
              status: "reported_route",
              destination_cidr: "10.0.0.0/16",
              origin: "CreateRoute",
              target: { kind: "local" },
            },
          },
        },
      ],
    },
  };
  return { view, value };
}
function open(detail: HTMLDetailsElement) {
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}
function setup(override?: SavedVpcCidrCoverage, data = fixture()) {
  let current = true;
  const lookup = vi.fn(override ?? (async () => structuredClone(data.value)));
  const root = renderVpcCidrCoverage(data.view, "subnet-a", 1, lookup, () => current);
  document.body.append(root);
  const controls = () => {
    open(root);
    const input = root.querySelector("input"),
      button = root.querySelector("button"),
      status = root.querySelector<HTMLElement>("[role=status]");
    if (!input || !button || !status) throw new Error("Missing controls");
    const enter = (value = "10.0.0.0/16", event = "input") => {
      input.value = value;
      input.dispatchEvent(new Event(event));
    };
    const intervals = () => {
      const target = [...root.querySelectorAll("details")].find((node) =>
        node.firstElementChild?.textContent?.startsWith("Decision intervals"),
      );
      if (!target) throw new Error("Missing interval detail");
      open(target);
      return target;
    };
    return { input, button, status, enter, intervals };
  };
  return {
    ...data,
    root,
    lookup,
    controls,
    retire: () => {
      current = false;
    },
  };
}
afterEach(() => document.body.replaceChildren());
describe("saved CIDR inspector", () => {
  it("is collapsed and independent, sends the literal query and lazily preserves all evidence as inert text", async () => {
    const f = setup();
    expect(f.root.querySelector("input")).toBeNull();
    expect(f.lookup).not.toHaveBeenCalled();
    const c = f.controls();
    expect(c.input.value).toBe("");
    expect(c.input.required).toBe(false);
    expect(f.root.querySelector("form")).toBeNull();
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    c.input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    c.button.click();
    expect(f.lookup).not.toHaveBeenCalled();
    c.enter();
    c.button.click();
    c.button.click();
    await settle();
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith({
      subnet_id: "subnet-a",
      destination_cidr: "10.0.0.0/16",
    });
    expect(c.status.textContent).toContain("Partition complete: 1");
    expect(f.root.querySelectorAll("[data-vpc-cidr-interval]")).toHaveLength(0);
    c.intervals();
    c.intervals();
    expect(f.root.querySelectorAll("[data-vpc-cidr-interval]")).toHaveLength(1);
    for (const detail of f.root.querySelectorAll("details")) open(detail);
    expect(f.root.textContent).toContain("<img src=x>");
    expect(f.root.querySelector("img,a,form")).toBeNull();
    expect(f.root.textContent).toContain("not usable connectivity");
    expect(c.button.disabled).toBe(false);
  });
  it("preserves every supported target/blackhole and rejects malformed nested decisions", async () => {
    for (const kind of [
      "local",
      "nat_gateway",
      "transit_gateway",
      "internet_gateway",
      "blackhole",
      "bad-target",
      "missing-origin",
      "missing-reason",
    ] as const) {
      const data = fixture(),
        result = required(data.value.coverage.segments[0]).result;
      if (result.status !== "reported" || result.lookup.status !== "reported_route")
        throw new Error("Missing route");
      if (kind === "blackhole")
        result.lookup = { status: "reported_blackhole", destination_cidr: "10.0.1.0/24" };
      else if (kind === "bad-target") Reflect.set(result.lookup.target, "kind", "future");
      else if (kind === "missing-origin") Reflect.deleteProperty(result.lookup, "origin");
      else if (kind === "missing-reason")
        result.lookup = { status: "unresolved", reason: "" as VpcLookupReason };
      else result.lookup.target = kind === "local" ? { kind } : { kind, id: `literal-${kind}-<img src=x>` };
      const f = setup(undefined, data),
        c = f.controls();
      c.enter();
      c.button.click();
      await settle();
      if (["bad-target", "missing-origin", "missing-reason"].includes(kind)) {
        expect(c.status.textContent).not.toContain("Partition complete");
        expect(f.root.querySelectorAll("details")).toHaveLength(0);
      } else {
        c.intervals();
        expect(f.root.textContent).toContain(kind === "blackhole" ? "reported_blackhole" : kind);
        expect(f.root.querySelector("img,a")).toBeNull();
      }
    }
  });
  it("binds complete original evidence independent of key order and lazily batches provenance/routes", async () => {
    const data = fixture(),
      table = required(data.view.topology.resources[2]);
    // Structural display fixture only; no new routing proof is claimed from repeated entries.
    table.routes = Array.from({ length: 101 }, () => structuredClone(required(table.routes[0])));
    data.view.topology.request_ids = Array.from({ length: 101 }, (_, i) => `request-${i}`);
    data.value.request_ids = [...data.view.topology.request_ids];
    required(data.value.coverage.table_evidence).original_table = Object.fromEntries(
      Object.entries(table).reverse(),
    ) as AwsResource;
    const f = setup(undefined, data),
      c = f.controls();
    c.enter();
    c.button.click();
    await settle();
    expect(c.status.textContent).toContain("Partition complete");
    const requests = required(
      [...f.root.querySelectorAll("details")].find(
        (d) => d.firstElementChild?.textContent === "Request IDs (101)",
      ),
    );
    open(requests);
    expect(requests.querySelectorAll("li")).toHaveLength(50);
    required(requests.querySelector("button")).click();
    required(requests.querySelector("button")).click();
    expect(requests.querySelectorAll("li")).toHaveLength(101);
    const raw = required(
      [...f.root.querySelectorAll("details")].find((d) =>
        d.firstElementChild?.textContent?.startsWith("Original table"),
      ),
    );
    open(raw);
    const routes = required(
      [...raw.querySelectorAll("details")].find((d) => d.firstElementChild?.textContent === "routes (101)"),
    );
    expect(routes.querySelectorAll("li")).toHaveLength(0);
    open(routes);
    expect(routes.querySelectorAll("li")).toHaveLength(50);
    const more = required(routes.querySelector("button"));
    c.enter("::/0");
    more.click();
    expect(routes.querySelectorAll("li")).toHaveLength(50);
  });
  it("retires a published result on an eventless invalid resubmit", async () => {
    const f = setup(),
      c = f.controls();
    c.enter();
    c.button.click();
    await settle();
    c.intervals();
    expect(f.root.querySelectorAll("[data-vpc-cidr-interval]")).toHaveLength(1);
    c.input.value = "";
    c.button.click();
    expect(f.root.querySelectorAll("[data-vpc-cidr-interval]")).toHaveLength(0);
    expect(c.status.textContent).toContain("Enter a literal");
  });
  const bad: [string, (value: VpcCidrCoverageResponse) => void][] = [
    [
      "account",
      (v) => {
        v.account_id = "other";
      },
    ],
    [
      "snapshot",
      (v) => {
        v.topology_id = "new";
      },
    ],
    [
      "time",
      (v) => {
        v.completed_at = "3";
      },
    ],
    [
      "AWS account",
      (v) => {
        v.aws_account_id = "other";
      },
    ],
    [
      "region",
      (v) => {
        v.region = "other";
      },
    ],
    [
      "subnet",
      (v) => {
        v.subnet_id = "other";
      },
    ],
    [
      "query",
      (v) => {
        v.destination_cidr = "::/0";
      },
    ],
    [
      "completeness",
      (v) => {
        v.complete_for_supported_queries = false;
      },
    ],
    [
      "limitations",
      (v) => {
        v.limitations = [];
      },
    ],
    [
      "requests",
      (v) => {
        v.request_ids.push("extra");
      },
    ],
    [
      "reference marker",
      (v) => {
        v.reference_only = false;
      },
    ],
    [
      "execution",
      (v) => {
        v.execution_enabled = true;
      },
    ],
    [
      "connectivity",
      (v) => {
        v.connectivity_tested = true;
      },
    ],
    [
      "missing flag",
      (v) => {
        Reflect.deleteProperty(v, "execution_enabled");
      },
    ],
    [
      "coverage query",
      (v) => {
        v.coverage.destination_cidr = "::/0";
      },
    ],
    [
      "partial",
      (v) => {
        v.coverage.partition_complete = false;
      },
    ],
    [
      "empty",
      (v) => {
        v.coverage.segments = [];
      },
    ],
    [
      "missing evidence",
      (v) => {
        v.coverage.table_evidence = null;
      },
    ],
    [
      "index",
      (v) => {
        if (v.coverage.table_evidence) v.coverage.table_evidence.route_table_resource_index = 1;
      },
    ],
    [
      "association",
      (v) => {
        if (v.coverage.table_evidence) v.coverage.table_evidence.source = "explicit_subnet";
      },
    ],
    [
      "original field",
      (v) => {
        if (v.coverage.table_evidence) v.coverage.table_evidence.original_table.tags = {};
      },
    ],
    [
      "malformed tail",
      (v) => {
        const cell = structuredClone(v.coverage.segments[0]);
        if (!cell) throw new Error();
        cell.result = { status: "future" } as unknown as typeof cell.result;
        v.coverage.segments.push(cell);
      },
    ],
  ];
  it.each(bad)("atomically rejects mismatched %s", async (_label, mutate) => {
    const data = fixture();
    mutate(data.value);
    const f = setup(undefined, data),
      c = f.controls();
    c.enter();
    c.button.click();
    await settle();
    expect(c.status.textContent).not.toContain("Partition complete");
    expect(c.status.textContent).toMatch(/refresh|Snapshot changed/);
    expect(f.root.querySelectorAll("[data-vpc-cidr-interval]")).toHaveLength(0);
    expect(f.root.querySelectorAll("details")).toHaveLength(0);
    expect(c.button.disabled).toBe(false);
  });
  it("keeps root scope and association unresolved with null evidence, including incomplete observations", async () => {
    for (const association of [false, true]) {
      const data = fixture();
      data.value.coverage.table_evidence = null;
      const cell = data.value.coverage.segments[0];
      if (!cell) throw new Error();
      cell.result = { status: "unresolved", reason: "scope_not_ready" };
      if (association) {
        data.view.topology.complete_for_supported_queries = data.value.complete_for_supported_queries = false;
        required(data.view.subnet_route_tables[0]).selection = {
          status: "unresolved",
          reason: "incomplete_observation",
        };
        cell.result = { status: "association_unresolved", reason: "incomplete_observation" };
      }
      const f = setup(undefined, data),
        c = f.controls();
      c.enter();
      c.button.click();
      await settle();
      c.intervals();
      expect(c.status.textContent).toContain("Partition complete");
      expect(f.root.textContent).toContain(association ? "incomplete_observation" : "scope_not_ready");
    }
  });
  it("validates every final interval before lazy batches and visits all101 rows exactly once", async () => {
    const data = fixture(),
      first = data.value.coverage.segments[0];
    if (!first) throw new Error();
    first.result = {
      status: "reported",
      route_table_id: "rtb-a",
      source: "implicit_main",
      lookup: { status: "unresolved", reason: "<img src=x> future" as VpcLookupReason },
    };
    // UI shape/batching fixture only; the server, not this UI, proves interval arithmetic.
    data.value.coverage.segments = Array.from({ length: 101 }, () => structuredClone(first));
    const f = setup(undefined, data),
      c = f.controls();
    c.enter();
    c.button.click();
    await settle();
    const detail = c.intervals();
    expect(detail.querySelectorAll("li")).toHaveLength(50);
    required(detail.querySelector("button")).click();
    expect(detail.querySelectorAll("li")).toHaveLength(100);
    required(detail.querySelector("button")).click();
    expect(detail.querySelectorAll("li")).toHaveLength(101);
    open(detail);
    expect(detail.querySelectorAll("li")).toHaveLength(101);
    expect(detail.querySelector("img")).toBeNull();
    expect(detail.textContent).toContain("future");
    const broken = fixture();
    broken.value.coverage.segments = structuredClone(data.value.coverage.segments);
    required(broken.value.coverage.segments[100]).start = "";
    const b = setup(undefined, broken),
      d = b.controls();
    d.enter();
    d.button.click();
    await settle();
    expect(d.status.textContent).not.toContain("Partition complete");
    expect(b.root.querySelectorAll("details")).toHaveLength(0);
  });
  it.each(["resolve", "reject"] as const)(
    "fences old %s and finally while a newer read remains pending",
    async (mode) => {
      const old = deferred<VpcCidrCoverageResponse>(),
        fresh = deferred<VpcCidrCoverageResponse>();
      let calls = 0;
      const f = setup(() => (++calls === 1 ? old.promise : fresh.promise)),
        c = f.controls();
      c.enter();
      c.button.click();
      c.enter("::/0", "change");
      expect(c.button.disabled).toBe(false);
      c.enter();
      c.button.click();
      if (mode === "resolve") old.resolve(f.value);
      else old.reject(new Error("old error"));
      await settle();
      expect(c.button.disabled).toBe(true);
      expect(c.status.textContent).toContain("Reading");
      expect(f.root.querySelectorAll("details")).toHaveLength(0);
      fresh.resolve(f.value);
      await settle();
      expect(c.button.disabled).toBe(false);
      expect(c.status.textContent).toContain("Partition complete");
    },
  );
  it.each(["resolve", "reject"] as const)(
    "detects eventless %s, discards safely and allows current retry",
    async (mode) => {
      const pending = deferred<VpcCidrCoverageResponse>();
      let calls = 0;
      const f = setup(() => (++calls === 1 ? pending.promise : Promise.resolve(fixture().value))),
        c = f.controls();
      c.enter();
      c.button.click();
      c.input.value = "::/0";
      if (mode === "resolve") pending.resolve(f.value);
      else pending.reject(new Error("old error"));
      await settle();
      expect(c.status.textContent).toContain("Inputs changed");
      expect(c.button.disabled).toBe(false);
      expect(f.root.querySelectorAll("details")).toHaveLength(0);
      c.enter();
      c.button.click();
      await settle();
      expect(c.status.textContent).toContain("Partition complete");
    },
  );
  it("captures accepted evidence, retires retained handlers and never queries after outer retirement", async () => {
    const data = fixture();
    const f = setup(async () => data.value, data),
      c = f.controls();
    c.enter();
    c.button.click();
    await settle();
    const intervals = required(
      [...f.root.querySelectorAll("details")].find((d) =>
        d.firstElementChild?.textContent?.startsWith("Decision intervals"),
      ),
    );
    required(data.value.coverage.segments[0]).start = "mutated after acceptance";
    open(intervals);
    expect(intervals.textContent).not.toContain("mutated");
    const raw = required(
      [...f.root.querySelectorAll("details")].find((d) =>
        d.firstElementChild?.textContent?.startsWith("Original table"),
      ),
    );
    c.enter("::/0");
    open(raw);
    expect(raw.children).toHaveLength(1);
    expect(f.root.querySelectorAll("details")).toHaveLength(0);
    f.retire();
    c.button.click();
    expect(f.lookup).toHaveBeenCalledTimes(1);
  });
  it("handles current errors and undefined replies, identical resubmits and UTF8 bounds without normalization", async () => {
    let call = 0;
    const f = setup(async () => {
        call++;
        if (call === 1) throw new Error("budget_exceeded");
        if (call === 2) return;
        return fixture().value;
      }),
      c = f.controls();
    c.enter("é".repeat(33));
    c.button.click();
    expect(f.lookup).not.toHaveBeenCalled();
    c.enter();
    c.button.click();
    await settle();
    expect(c.status.textContent).toContain("budget_exceeded");
    c.button.click();
    await settle();
    expect(c.status.textContent).toContain("discarded");
    c.button.click();
    await settle();
    expect(c.status.textContent).toContain("Partition complete");
    c.intervals();
    c.button.click();
    expect(f.root.querySelectorAll("[data-vpc-cidr-interval]")).toHaveLength(0);
    await settle();
    expect(f.lookup).toHaveBeenCalledTimes(4);
  });
  it("keeps malformed source context unavailable locally without constructing controls", () => {
    for (const poison of ["duplicate", "flags", "limitations", "control"] as const) {
      const data = fixture();
      if (poison === "duplicate")
        data.view.subnet_route_tables.push(structuredClone(required(data.view.subnet_route_tables[0])));
      if (poison === "flags") Reflect.deleteProperty(data.view.topology, "execution_enabled");
      if (poison === "limitations") Reflect.set(data.view.topology, "limitations", "not an array");
      if (poison === "control") data.view.topology.completed_at = "bad";
      const f = setup(undefined, data);
      open(f.root);
      open(f.root);
      expect(f.root.textContent).toContain("unavailable");
      expect(f.root.querySelector("input")).toBeNull();
      expect(f.lookup).not.toHaveBeenCalled();
    }
  });
});

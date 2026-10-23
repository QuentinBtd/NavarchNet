import { expect, it, vi } from "vitest";
import type { VpcLookupRequest, VpcLookupResponse } from "./generated";
import { renderSourceAttachmentEntry, type SourceVpcContext } from "./source-attachment-entry-view";
import type { SavedVpcLookup } from "./vpc-lookup-view";

const parent = {
  topologyId: "source-snapshot",
  completedAt: "2",
  sourceSubnetId: "source-subnet",
  outboundDestination: "203.0.113.1",
  attachmentSubnetId: "attachment-subnet",
  sourceSelection: { status: "selected", route_table_id: "rtb-source", source: "implicit_main" },
} as const;
function context(lookup: SavedVpcLookup): SourceVpcContext {
  return {
    snapshot: {
      id: parent.topologyId,
      account_id: "source-a",
      completed_at: "2",
      execution_enabled: false,
      connectivity_tested: false,
    },
    subnetRouteTables: [
      { subnet_id: parent.sourceSubnetId, vpc_id: "vpc-source", selection: { ...parent.sourceSelection } },
      {
        subnet_id: parent.attachmentSubnetId,
        vpc_id: "vpc-source",
        selection: { status: "selected", route_table_id: "rtb-attachment", source: "explicit_subnet" },
      },
    ],
    lookup,
  };
}
function body(query: VpcLookupRequest): VpcLookupResponse {
  return {
    ...query,
    topology_id: parent.topologyId,
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
}
function controls(root: HTMLElement) {
  const input = root.querySelector("input"),
    button = root.querySelector("button"),
    output = root.querySelector('[role="status"]');
  if (!input || !button || !output) throw new Error("Missing controls");
  return { root, input, button, output };
}
function open(
  lookup: SavedVpcLookup = async (query) => body(query),
  current = () => true,
  ctx = context(lookup),
) {
  return controls(renderSourceAttachmentEntry(ctx, parent, 0, current));
}
const flush = () => new Promise((done) => setTimeout(done, 0));
function deferred() {
  let resolve: (value: VpcLookupResponse | undefined) => void = () => {
    throw new Error("No resolver");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("No rejecter");
  };
  const promise = new Promise<VpcLookupResponse | undefined>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it("preserves selected/main, blackhole and unresolved outcomes without following any target or provider markup", async () => {
  for (const mode of [
    "implicit_main",
    "blackhole",
    "association",
    "entry",
    "scope",
    "nat",
    "unknown-reason",
  ]) {
    const ctx = context(async (query) => {
      const value = body(query);
      if (mode === "association")
        value.result = { status: "association_unresolved", reason: "missing_route_table" };
      else if (mode === "scope") value.result = { status: "unresolved", reason: "scope_not_ready" };
      else if (value.result.status === "reported") {
        if (mode === "implicit_main") value.result.source = "implicit_main";
        if (mode === "blackhole")
          value.result.lookup = { status: "reported_blackhole", destination_cidr: "10.10.1.0/24" };
        if (mode === "entry" || mode === "unknown-reason")
          value.result.lookup = {
            status: "unresolved",
            reason: mode === "entry" ? "unsupported_target" : ("future-<img src=x>" as "unsupported_target"),
          };
        if (mode === "nat" && value.result.lookup.status === "reported_route")
          value.result.lookup.target = { kind: "nat_gateway", id: "<img src=x>" };
      }
      return value;
    });
    const row = ctx.subnetRouteTables[1];
    if (!row) throw new Error("Missing row");
    if (mode === "association") row.selection = { status: "unresolved", reason: "missing_route_table" };
    if (mode === "implicit_main" && row.selection.status === "selected")
      row.selection.source = "implicit_main";
    const view = open(ctx.lookup, () => true, ctx);
    view.input.value = "10.10.1.10";
    view.button.click();
    await flush();
    const expected = {
      implicit_main: "implicit_main",
      blackhole: "blackhole",
      association: "association unresolved",
      entry: "unsupported_target",
      scope: "scope_not_ready",
      nat: "<img src=x>",
      "unknown-reason": "future-<img src=x>",
    }[mode];
    expect(view.output.textContent).toContain(expected);
    expect(view.root.querySelector("img,a,form,fieldset")).toBeNull();
    expect(view.root.querySelectorAll("button")).toHaveLength(1);
  }
});
it("rejects malformed identity, association, target and exact-false markers before publishing an entry", async () => {
  for (const fault of [
    "snapshot",
    "subnet",
    "destination",
    "table",
    "source",
    "target",
    "origin",
    "route-status",
    "result-status",
    "association",
    "missing-execution",
    "null-execution",
    "true-execution",
    "missing-connectivity",
    "null-connectivity",
    "true-connectivity",
  ]) {
    const view = open(async (query) => {
      const value = body(query);
      if (fault === "snapshot") value.topology_id = "new-source";
      if (fault === "subnet") value.subnet_id = parent.sourceSubnetId;
      if (fault === "destination") value.destination = parent.outboundDestination;
      for (const key of ["execution_enabled", "connectivity_tested"] as const) {
        const suffix = key === "execution_enabled" ? "execution" : "connectivity";
        if (fault === `missing-${suffix}`) Reflect.deleteProperty(value, key);
        if (fault === `null-${suffix}`) value[key] = null as unknown as boolean;
        if (fault === `true-${suffix}`) value[key] = true;
      }
      if (value.result.status === "reported") {
        if (fault === "table") value.result.route_table_id = "tgw-table";
        if (fault === "source") value.result.source = "implicit_main";
        if (value.result.lookup.status === "reported_route") {
          if (fault === "target")
            value.result.lookup.target = { kind: "unknown" } as unknown as typeof value.result.lookup.target;
          if (fault === "origin") Reflect.deleteProperty(value.result.lookup, "origin");
          if (fault === "route-status") Reflect.set(value.result.lookup, "status", "future");
        }
      }
      if (fault === "result-status") Reflect.set(value.result, "status", "future");
      if (fault === "association")
        value.result = { status: "association_unresolved", reason: "missing_route_table" };
      return value;
    });
    view.input.value = "10.10.254.10";
    view.button.click();
    await flush();
    expect(view.output.textContent).not.toContain("Reported attachment-subnet entry");
    expect(view.output.textContent).toContain(fault === "snapshot" ? "Snapshot changed" : "did not match");
    expect(view.button.disabled).toBe(false);
  }
});
it("copies snapshot and table scalars, leaves the input blank, validates only the explicit action and suppresses parent Enter", async () => {
  const lookup = vi.fn(async (query: VpcLookupRequest) => body(query));
  const ctx = context(lookup),
    view = open(lookup, () => true, ctx);
  ctx.snapshot.id = "mutated";
  const row = ctx.subnetRouteTables[1];
  if (row?.selection.status === "selected") row.selection.route_table_id = "mutated";
  view.button.click();
  expect(lookup).not.toHaveBeenCalled();
  expect(view.input.required).toBe(false);
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  view.input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  view.input.value = "x".repeat(65);
  view.button.click();
  expect(lookup).not.toHaveBeenCalled();
  view.input.value = "10.10.254.10";
  view.button.click();
  view.button.click();
  await flush();
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    subnet_id: parent.attachmentSubnetId,
    destination: "10.10.254.10",
  });
  expect(view.output.textContent).toContain("Reported attachment-subnet entry");
});
it("keeps a newer request's controls and status owned despite old success or rejection after input/change ABA", async () => {
  for (const failed of [false, true]) {
    const old = deferred(),
      next = deferred();
    let count = 0;
    const view = open(async () => (++count === 1 ? old.promise : next.promise));
    view.input.value = "10.10.1.10";
    view.button.click();
    view.button.click();
    expect(count).toBe(1);
    view.input.value = "10.10.2.10";
    view.input.dispatchEvent(new Event("input"));
    expect(view.button.disabled).toBe(false);
    view.input.value = "10.10.1.10";
    view.input.dispatchEvent(new Event("change"));
    view.button.click();
    expect(count).toBe(2);
    if (failed) old.reject(new Error("obsolete error"));
    else old.resolve(body({ subnet_id: parent.attachmentSubnetId, destination: view.input.value }));
    await flush();
    expect(view.output.textContent).toContain("Reading saved");
    expect(view.input.disabled).toBe(true);
    expect(view.button.disabled).toBe(true);
    next.resolve(body({ subnet_id: parent.attachmentSubnetId, destination: view.input.value }));
    await flush();
    expect(view.output.textContent).toContain("Reported attachment-subnet entry");
    expect(view.button.disabled).toBe(false);
  }
});
it("permits current error/discard retry and retires eventless success/error with usable controls and guidance", async () => {
  for (const mode of ["error", "discard", "eventless-success", "eventless-error"]) {
    const pending = deferred();
    let count = 0;
    const view = open(async (query) => (++count === 1 ? pending.promise : body(query)));
    view.input.value = "10.10.1.10";
    view.button.click();
    if (mode.startsWith("eventless")) view.input.value = "10.10.2.10";
    if (mode.endsWith("error")) pending.reject(new Error("current failure"));
    else
      pending.resolve(
        mode === "discard"
          ? undefined
          : body({ subnet_id: parent.attachmentSubnetId, destination: "10.10.1.10" }),
      );
    await flush();
    expect(view.output.textContent).toContain(
      mode.startsWith("eventless") ? "Inputs changed" : mode === "error" ? "current failure" : "discarded",
    );
    expect(view.button.disabled).toBe(false);
    view.button.click();
    await flush();
    expect(view.output.textContent).toContain("Reported attachment-subnet entry");
    expect(count).toBe(2);
  }
});
it("upstream retirement fences retained controls and pending successes/errors without re-querying", async () => {
  for (const failed of [false, true]) {
    let live = true;
    const pending = deferred(),
      lookup = vi.fn(async () => pending.promise);
    const view = open(lookup, () => live);
    view.input.value = "10.10.1.10";
    view.button.click();
    live = false;
    if (failed) pending.reject(new Error("obsolete parent"));
    else pending.resolve(body({ subnet_id: parent.attachmentSubnetId, destination: view.input.value }));
    await flush();
    view.button.disabled = false;
    view.button.click();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(view.output.textContent).not.toContain("Reported attachment-subnet entry");
    expect(view.output.textContent).not.toContain("obsolete parent");
  }
});

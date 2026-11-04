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
function lifecycleResponse(
  engine: "VPC" | "TGW",
  destination: string,
): VpcLookupResponse | TgwLookupResponse {
  return engine === "VPC"
    ? { ...value, destination }
    : {
        topology_id: "snapshot",
        route_table_id: "table",
        destination,
        result: { status: "reported_blackhole", destination_cidr: "0.0.0.0/0" },
        execution_enabled: false,
        connectivity_tested: false,
      };
}
function lifecycleForm(engine: "VPC" | "TGW", run: (destination: string) => Promise<unknown>) {
  return engine === "VPC"
    ? renderVpcLookup(
        "snapshot",
        "subnet-a",
        selection,
        0,
        async (query) => (await run(query.destination)) as VpcLookupResponse,
      )
    : renderTgwLookup(
        "snapshot",
        "table",
        0,
        async (query) => (await run(query.destination)) as TgwLookupResponse,
      );
}
for (const engine of ["VPC", "TGW"] as const) {
  it(`${engine} clears a completed saved result when the destination changes`, async () => {
    const form =
      engine === "VPC"
        ? render(value)
        : renderTgwLookup("snapshot", "table", 0, async (query) => ({
            topology_id: "snapshot",
            route_table_id: "table",
            destination: query.destination,
            result: { status: "reported_blackhole", destination_cidr: "0.0.0.0/0" },
            execution_enabled: false,
            connectivity_tested: false,
          }));
    await submit(form);
    expect(form.textContent).toContain("Reported");
    const input = form.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing input");
    input.value = "203.0.113.2";
    input.dispatchEvent(new Event("input"));
    expect(form.textContent).not.toContain("Reported");
    expect(form.textContent).toContain("run another saved lookup");
    expect(form.textContent).toContain(
      engine === "VPC" ? "untested" : "not a full path or measured connectivity",
    );
  });
  it(`${engine} retires pending input generations including ABA without old completion unlocking a newer request`, async () => {
    for (const changedDestination of ["203.0.113.2", "203.0.113.1"]) {
      for (const rejected of [false, true]) {
        const pending: {
          destination: string;
          resolve: (value: unknown) => void;
          reject: (reason: Error) => void;
        }[] = [];
        const form = lifecycleForm(
          engine,
          (destination) => new Promise((resolve, reject) => pending.push({ destination, resolve, reject })),
        );
        const input = form.querySelector<HTMLInputElement>("input");
        const button = form.querySelector<HTMLButtonElement>("button");
        const status = form.querySelector<HTMLElement>('[role="status"]');
        if (!input || !button || !status) throw new Error("Missing lookup controls");
        input.value = "203.0.113.1";
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        expect(pending).toHaveLength(1);
        input.value = "203.0.113.2";
        input.dispatchEvent(new Event("input"));
        input.value = changedDestination;
        input.dispatchEvent(new Event("change"));
        expect(button.disabled).toBe(false);
        expect(input.disabled).toBe(false);
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        expect(pending).toHaveLength(2);
        const old = pending[0],
          current = pending[1];
        if (!old || !current) throw new Error("Missing pending lookup");
        if (rejected) old.reject(new Error("obsolete failure must not appear"));
        else old.resolve(lifecycleResponse(engine, old.destination));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(status.textContent).toContain("Reading saved");
        expect(button.disabled).toBe(true);
        expect(input.disabled).toBe(true);
        expect(status.textContent).not.toContain("obsolete failure");
        current.resolve(lifecycleResponse(engine, current.destination));
        await expect.poll(() => status.textContent).toContain(`Reported`);
        expect(status.textContent).toContain(changedDestination);
        expect(button.disabled).toBe(false);
        expect(input.disabled).toBe(false);
      }
    }
  });
}
for (const engine of ["VPC", "TGW"] as const) {
  it(`${engine} restores controls after a current rejection or discard and permits a clean retry`, async () => {
    for (const rejected of [false, true]) {
      let calls = 0;
      const form = lifecycleForm(engine, async (destination) => {
        calls++;
        if (calls === 1) {
          if (rejected) throw new Error("current lookup failed");
          return undefined;
        }
        return lifecycleResponse(engine, destination);
      });
      expect(await submit(form)).toContain(rejected ? "current lookup failed" : "Lookup discarded");
      expect(await submit(form)).toContain("Reported");
      expect(calls).toBe(2);
    }
  });
  it(`${engine} discards success and error after an eventless value change without stranding controls`, async () => {
    for (const rejected of [false, true]) {
      let resolve: (value: unknown) => void = () => {};
      let reject: (reason: Error) => void = () => {};
      const pending = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const form = lifecycleForm(engine, async () => pending);
      const input = form.querySelector<HTMLInputElement>("input");
      const button = form.querySelector<HTMLButtonElement>("button");
      if (!input || !button) throw new Error("Missing controls");
      input.value = "203.0.113.1";
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      input.value = "203.0.113.2";
      if (rejected) reject(new Error("eventless obsolete error"));
      else resolve(lifecycleResponse(engine, "203.0.113.1"));
      await expect.poll(() => button.disabled).toBe(false);
      expect(input.disabled).toBe(false);
      expect(form.textContent).toContain("run another saved lookup");
      expect(form.textContent).not.toContain("Reported");
      expect(form.textContent).not.toContain("eventless obsolete error");
    }
  });
}
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

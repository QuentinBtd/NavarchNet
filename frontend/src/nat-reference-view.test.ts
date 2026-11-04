import { expect, it } from "vitest";
import type { AwsResource, NatReferenceResponse, VpcSubnetLookupResult } from "./generated";
import type { NatReferenceParent, SavedNatReferenceLookup } from "./nat-reference-view";
import { renderVpcLookup } from "./vpc-lookup-view";

// Malformed/deferred renderer fixtures, not backend or live AWS acceptance.
const entry: VpcSubnetLookupResult = {
  status: "reported",
  route_table_id: "rtb",
  source: "implicit_main",
  lookup: {
    status: "reported_route",
    destination_cidr: "0.0.0.0/0",
    origin: "CreateRoute",
    target: { kind: "nat_gateway", id: "nat-<img src=x>" },
  },
};
function resource(): AwsResource {
  return {
    kind: "nat_gateway",
    id: "nat-<img src=x>",
    owner_account_id: "123456789012",
    vpc_id: null,
    subnet_id: null,
    az_id: null,
    state: "future-<img src=x>",
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
    availability_mode: "unknown-mode",
    nat_gateway: {
      route_table_id: "literal-<img src=x>",
      addresses: [
        {
          allocation_id: null,
          association_id: null,
          network_interface_id: null,
          public_ip: "203.0.113.1",
          private_ip: null,
          az_name: "name-not-id",
          az_id: null,
          is_primary: false,
          status: "failed",
        },
      ],
    },
    managed: false,
  };
}
function reply(): NatReferenceResponse {
  return {
    account_id: "account",
    topology_id: "snapshot",
    completed_at: "2",
    subnet_id: "subnet",
    destination: "203.0.113.1",
    result: {
      subnet_lookup: structuredClone(entry),
      reference: {
        status: "reported_record",
        resource: resource(),
        owner_scope: "reported_same",
        vpc_scope: "not_reported",
      },
    },
    reference_only: true,
    execution_enabled: false,
    connectivity_tested: false,
  };
}
const flush = () => new Promise<void>((done) => setTimeout(done, 0));
async function setup(
  lookup: SavedNatReferenceLookup = async () => reply(),
  original = entry,
  configure?: (parent: NatReferenceParent) => NatReferenceParent,
) {
  let live = true;
  const calls: unknown[] = [];
  let parent: NatReferenceParent = {
    snapshot: {
      id: "snapshot",
      account_id: "account",
      aws_account_id: "123456789012",
      completed_at: "2",
      execution_enabled: false,
      connectivity_tested: false,
    },
    subnetVpcId: "vpc",
    isCurrent: () => live,
    lookup: async (query) => {
      calls.push(query);
      return lookup(query);
    },
  };
  if (configure) parent = configure(parent);
  const form = renderVpcLookup(
    "snapshot",
    "subnet",
    { status: "selected", route_table_id: "rtb", source: "implicit_main" },
    0,
    async (query) => ({
      topology_id: "snapshot",
      ...query,
      result: structuredClone(original),
      execution_enabled: false,
      connectivity_tested: false,
    }),
    parent,
  );
  const input = form.querySelector<HTMLInputElement>("input");
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!input || !submit) throw new Error("Missing parent controls");
  input.value = "203.0.113.1";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  return {
    form,
    input,
    submit,
    calls,
    retire: () => {
      live = false;
    },
  };
}
function controls(form: HTMLFormElement) {
  const panel = form.querySelector<HTMLFieldSetElement>("fieldset[data-nat-reference]");
  const action = panel?.querySelector<HTMLButtonElement>("button");
  if (!panel || !action) throw new Error("Missing reference control");
  return { panel, action };
}
function open(panel: HTMLElement) {
  const detail = panel.querySelector<HTMLDetailsElement>("details");
  if (!detail) throw new Error("Missing raw inspector");
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
  return detail;
}
it("joins only after explicit action, preserves raw failed/unknown metadata and excludes duplicates", async () => {
  let resolve!: (value: NatReferenceResponse) => void;
  const value = reply();
  const before = JSON.stringify(value);
  const view = await setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { panel, action } = controls(view.form);
  expect(view.calls).toHaveLength(0);
  expect(action.type).toBe("button");
  expect(view.form.checkValidity()).toBe(true);
  action.click();
  action.click();
  expect(view.calls).toEqual([{ subnet_id: "subnet", destination: "203.0.113.1" }]);
  expect(view.input.disabled).toBe(false);
  expect(view.submit.disabled).toBe(false);
  resolve(value);
  await flush();
  expect(action.disabled).toBe(false);
  expect(panel.textContent).toContain("Referenced saved NAT record: nat-<img src=x>");
  expect(panel.textContent).toContain("not ownership, authority or routing validation");
  const detail = open(panel);
  expect(detail.textContent).toContain("Reported status: failed");
  expect(detail.textContent).toContain("Reported primary: false");
  expect(detail.textContent).toContain("unknown-mode");
  expect(detail.textContent).toContain("AZ ID: not reported");
  expect(panel.querySelector("img, a, form, input, select")).toBeNull();
  expect(view.form.querySelector("p fieldset")).toBeNull();
  expect(JSON.stringify(value)).toBe(before);
});
it("rejects changed envelope, original entry, record identity, malformed fields and inconsistent factual scopes before inspection", async () => {
  const changes: [string, unknown][] = [];
  for (const field of ["account_id", "topology_id", "completed_at", "subnet_id", "destination"])
    changes.push([field, "other"]);
  for (const field of ["reference_only", "execution_enabled", "connectivity_tested"])
    for (const bad of [undefined, null, "false", 0, field !== "reference_only"]) changes.push([field, bad]);
  for (const field of ["status", "route_table_id", "source"])
    changes.push([`result.subnet_lookup.${field}`, "other"]);
  for (const field of ["status", "destination_cidr", "origin"])
    changes.push([`result.subnet_lookup.lookup.${field}`, "other"]);
  for (const field of ["kind", "id"])
    changes.push(
      [`result.subnet_lookup.lookup.target.${field}`, "other"],
      [`result.reference.resource.${field}`, "other"],
    );
  for (const field of ["owner_account_id", "vpc_id", "state", "availability_mode"])
    for (const bad of [undefined, false, {}]) changes.push([`result.reference.resource.${field}`, bad]);
  for (const field of ["owner_scope", "vpc_scope"])
    for (const bad of [undefined, null, "unknown", "reported_different"])
      changes.push([`result.reference.${field}`, bad]);
  changes.push(
    ["result", null],
    ["result.reference", null],
    ["result.reference.status", "unknown"],
    ["result.reference", { status: "unresolved", reason: "unknown" }],
  );
  for (const [path, bad] of changes) {
    const value = reply();
    const keys = path.split(".");
    const leaf = keys.pop();
    let object = value as unknown as Record<string, unknown>;
    for (const key of keys) object = object[key] as Record<string, unknown>;
    if (!leaf) throw new Error("Bad mutation path");
    object[leaf] = bad;
    const view = await setup(async () => value);
    const { panel, action } = controls(view.form);
    action.click();
    await flush();
    expect(panel.querySelector("details"), JSON.stringify(value)).toBeNull();
    expect(panel.textContent).not.toContain("Referenced saved NAT record:");
    expect(action.disabled).toBe(false);
    expect(view.form.textContent).toContain("Reported subnet entry:");
  }
});
it("keeps same, different and unreported fields descriptive, including null expected VPC", async () => {
  const scope = (a: string | null, b: string | null) =>
    a === null || b === null ? "not_reported" : a === b ? "reported_same" : "reported_different";
  for (const owner of [null, "123456789012", "different"])
    for (const observed of [null, "vpc", "different"])
      for (const expected of [null, "vpc"]) {
        const value = reply();
        if (value.result.reference.status !== "reported_record") throw new Error("Bad fixture");
        value.result.reference.resource.owner_account_id = owner;
        value.result.reference.resource.vpc_id = observed;
        value.result.reference.owner_scope = scope(owner, "123456789012");
        value.result.reference.vpc_scope = scope(observed, expected);
        const view = await setup(
          async () => value,
          entry,
          (parent) => ({ ...parent, subnetVpcId: expected }),
        );
        const { panel, action } = controls(view.form);
        action.click();
        await flush();
        expect(panel.textContent).toContain("Referenced saved NAT record:");
        expect(panel.textContent).toContain(`field: ${scope(observed, expected)}`);
        expect(panel.textContent).toContain("not ownership, authority or routing validation");
      }
});
it("renders known unresolved references without replacing the original entry and rejects unbound unresolved replies", async () => {
  for (const reason of [
    "no_reported_nat_reference",
    "missing_or_ambiguous_record",
    "incomplete_observation",
    "unsupported_region",
  ] as const) {
    const value = reply();
    value.result.reference = { status: "unresolved", reason };
    const view = await setup(async () => value);
    const { panel, action } = controls(view.form);
    action.click();
    await flush();
    expect(panel.textContent).toContain(`unresolved: ${reason}`);
    expect(panel.querySelector("details")).toBeNull();
    expect(view.form.textContent).toContain("Reported subnet entry:");
    value.completed_at = "changed";
    action.click();
    await flush();
    expect(panel.textContent).toContain("did not match");
    expect(panel.textContent).not.toContain(`unresolved: ${reason}`);
  }
});
it("restores child retry after current rejection or discard without blocking parent validity", async () => {
  let count = 0;
  const view = await setup(async () => {
    count++;
    if (count === 1) throw new Error("current failure");
    if (count === 2) return undefined;
    return reply();
  });
  const { panel, action } = controls(view.form);
  for (const expected of ["current failure", "discarded", "Referenced saved NAT record:"]) {
    action.click();
    await flush();
    expect(panel.textContent).toContain(expected);
    expect(action.disabled).toBe(false);
    expect(view.form.checkValidity()).toBe(true);
  }
  expect(view.calls).toHaveLength(3);
});
it("retires old child generations on identical resubmit, input/change/ABA and upstream retirement", async () => {
  for (const retirement of ["resubmit", "input", "change", "ABA", "upstream"])
    for (const reject of [false, true]) {
      const pending: { resolve: (value: NatReferenceResponse) => void; reject: (error: Error) => void }[] =
        [];
      const view = await setup(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
      const old = controls(view.form);
      old.action.click();
      if (retirement === "upstream") view.retire();
      else if (retirement === "resubmit") view.form.dispatchEvent(new Event("submit", { cancelable: true }));
      else {
        view.input.value = "203.0.113.2";
        view.input.dispatchEvent(new Event(retirement === "change" ? "change" : "input"));
        if (retirement === "ABA") {
          view.input.value = "203.0.113.1";
          view.input.dispatchEvent(new Event("change"));
        }
      }
      await flush();
      old.action.disabled = false;
      old.action.click();
      expect(pending).toHaveLength(1);
      if (retirement === "resubmit") controls(view.form).action.click();
      const first = pending[0];
      if (!first) throw new Error("Missing pending");
      if (reject) first.reject(new Error("obsolete failure"));
      else first.resolve(reply());
      await flush();
      expect(old.panel.textContent).not.toContain("Referenced saved NAT record:");
      expect(old.panel.textContent).not.toContain("obsolete failure");
      if (retirement === "resubmit") {
        const next = controls(view.form);
        expect(next.action.disabled).toBe(true);
        expect(next.panel.textContent).toContain("Reading saved NAT");
        pending[1]?.resolve(reply());
        await flush();
        expect(next.panel.textContent).toContain("Referenced saved NAT record:");
      }
    }
});
it("eventless destination change retires a pending child with an explicit refresh instruction", async () => {
  for (const reject of [false, true]) {
    let resolve!: (value: NatReferenceResponse) => void, fail!: (error: Error) => void;
    const view = await setup(
      () =>
        new Promise((done, bad) => {
          resolve = done;
          fail = bad;
        }),
    );
    const { panel, action } = controls(view.form);
    action.click();
    view.input.value = "203.0.113.2";
    if (reject) fail(new Error("obsolete"));
    else resolve(reply());
    await flush();
    expect(panel.textContent).toContain("run another saved subnet lookup");
    expect(panel.textContent).not.toContain("Reading saved NAT");
    expect(panel.querySelector("details")).toBeNull();
    expect(view.input.disabled).toBe(false);
    expect(view.submit.disabled).toBe(false);
  }
});
it("guards retained lazy metadata and continuation after retirement", async () => {
  const value = reply();
  if (value.result.reference.status !== "reported_record") throw new Error("Bad fixture");
  const metadata = value.result.reference.resource.nat_gateway;
  if (!metadata?.addresses?.[0]) throw new Error("Bad fixture");
  const address = metadata.addresses[0];
  metadata.addresses = Array.from({ length: 101 }, () => structuredClone(address));
  const view = await setup(async () => value);
  const { panel, action } = controls(view.form);
  action.click();
  await flush();
  const detail = open(panel);
  expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(50);
  view.retire();
  detail.querySelector<HTMLButtonElement>("button[data-nat-more]")?.click();
  detail.open = false;
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
  expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(50);
  const other = await setup();
  const child = controls(other.form);
  child.action.click();
  await flush();
  other.retire();
  const unopened = open(child.panel);
  expect(unopened.querySelectorAll("[data-nat-address]")).toHaveLength(0);
});
it("does not offer a child for any non-NAT result or malformed snapshot markers", async () => {
  const originals: VpcSubnetLookupResult[] = [
    {
      status: "reported",
      route_table_id: "rtb",
      source: "implicit_main",
      lookup: {
        status: "reported_route",
        destination_cidr: "10.0.0.0/8",
        origin: "CreateRoute",
        target: { kind: "local" },
      },
    },
    {
      status: "reported",
      route_table_id: "rtb",
      source: "implicit_main",
      lookup: { status: "reported_blackhole", destination_cidr: "0.0.0.0/0" },
    },
    {
      status: "reported",
      route_table_id: "rtb",
      source: "implicit_main",
      lookup: { status: "unresolved", reason: "unsupported_target" },
    },
    { status: "unresolved", reason: "invalid_destination" },
  ];
  for (const original of originals)
    expect((await setup(undefined, original)).form.querySelector("fieldset")).toBeNull();
  for (const key of [
    "id",
    "account_id",
    "aws_account_id",
    "completed_at",
    "execution_enabled",
    "connectivity_tested",
  ]) {
    const view = await setup(undefined, entry, (parent) => ({
      ...parent,
      snapshot: { ...parent.snapshot, [key]: undefined },
    }));
    expect(view.form.querySelector("fieldset")).toBeNull();
    expect(view.calls).toHaveLength(0);
  }
});

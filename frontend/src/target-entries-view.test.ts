import { expect, it, vi } from "vitest";
import type { NatReferenceResponse, TgwTargetResponse, VpcLookupRequest } from "./generated";
import type { NatReferenceParent } from "./nat-reference-view";
import { renderTargetEntries } from "./target-entries-view";

// Malformed/deferred renderer fixtures, not backend, browser or AWS acceptance.
const context = {
  topologyId: "network-snapshot",
  completedAt: "4",
  gatewayId: "tgw-network",
  attachmentIds: ["target-a", "target-b"],
  destination: "203.0.113.1",
};
const value: TgwTargetResponse = {
  topology_id: "network-snapshot",
  completed_at: "4",
  transit_gateway_id: "tgw-network",
  target_attachment_id: "target-a",
  destination: "203.0.113.1",
  az_selection: "not_inferred",
  execution_enabled: false,
  connectivity_tested: false,
  result: {
    status: "reported_subnets",
    vpc_id: "vpc-target",
    subnets: [
      {
        subnet_id: "subnet-a",
        az_id: "euw1-az1",
        lookup: {
          status: "reported",
          route_table_id: "rtb-a",
          source: "implicit_main",
          lookup: {
            status: "reported_route",
            destination_cidr: "0.0.0.0/0",
            origin: "CreateRoute",
            target: { kind: "nat_gateway", id: "<img src=x>" },
          },
        },
      },
      {
        subnet_id: "subnet-b",
        az_id: "euw1-az2",
        lookup: {
          status: "reported",
          route_table_id: "rtb-b",
          source: "explicit_subnet",
          lookup: { status: "reported_blackhole", destination_cidr: "0.0.0.0/0" },
        },
      },
    ],
  },
};
function render(body: unknown = value, current = () => true) {
  return renderTargetEntries(context, 0, async () => body as TgwTargetResponse, current);
}
function choose(fieldset: HTMLFieldSetElement) {
  const select = fieldset.querySelector("select");
  if (!select) throw new Error("Missing choice");
  select.value = "target-a";
  return select;
}
function joinedBody(): TgwTargetResponse {
  const body = structuredClone(value);
  if (body.result.status !== "reported_subnets") throw new Error("Bad fixture");
  const first = body.result.subnets[0],
    second = body.result.subnets[1];
  if (!first || !second) throw new Error("Missing rows");
  second.lookup = structuredClone(first.lookup);
  return body;
}
function natBody(query: VpcLookupRequest): NatReferenceResponse {
  const body = joinedBody();
  if (body.result.status !== "reported_subnets") throw new Error("Bad fixture");
  const row = body.result.subnets.find((row) => row.subnet_id === query.subnet_id);
  if (!row) throw new Error("Unknown subnet");
  return {
    account_id: "network",
    topology_id: "network-snapshot",
    completed_at: "4",
    ...query,
    reference_only: true,
    execution_enabled: false,
    connectivity_tested: false,
    result: {
      subnet_lookup: row.lookup,
      reference: {
        status: "reported_record",
        owner_scope: "reported_same",
        vpc_scope: "not_reported",
        resource: {
          kind: "nat_gateway",
          id: "<img src=x>",
          owner_account_id: "210987654321",
          vpc_id: null,
          subnet_id: null,
          az_id: null,
          state: "failed",
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
          availability_mode: "future-mode",
          nat_gateway: null,
          managed: false,
        },
      },
    },
  };
}
function natParent(
  lookup: NatReferenceParent["lookup"] = async (query) => natBody(query),
): Omit<NatReferenceParent, "subnetVpcId"> {
  return {
    snapshot: {
      id: "network-snapshot",
      completed_at: "4",
      account_id: "network",
      aws_account_id: "210987654321",
      execution_enabled: false,
      connectivity_tested: false,
    },
    lookup,
    isCurrent: () => true,
  };
}
it("stages every subnet NAT action without deduplicating a shared ID and binds B's literal fields", async () => {
  const calls: VpcLookupRequest[] = [];
  const fieldset = renderTargetEntries(
    context,
    0,
    async () => joinedBody(),
    () => true,
    natParent(async (query) => {
      calls.push(query);
      return natBody(query);
    }),
  );
  choose(fieldset);
  click(fieldset);
  await finished(fieldset);
  const children = fieldset.querySelectorAll<HTMLFieldSetElement>("fieldset[data-nat-reference]");
  expect(children).toHaveLength(2);
  expect(calls).toHaveLength(0);
  for (const [index, child] of [...children].entries()) {
    child.querySelector("button")?.click();
    await new Promise((done) => setTimeout(done, 0));
    expect(child.textContent).toContain("Referenced saved NAT record: <img src=x>");
    expect(child.textContent).toContain("reported_same");
    expect(child.textContent).toContain("not_reported");
    expect(calls[index]).toEqual({
      subnet_id: index === 0 ? "subnet-a" : "subnet-b",
      destination: context.destination,
    });
  }
  expect(fieldset.querySelector("img, form, input")).toBeNull();
  expect(status(fieldset)).toContain("subnet-a");
  expect(status(fieldset)).toContain("subnet-b");
});
it("validates a malformed final NAT row and supplied snapshot before exposing any prefix children", async () => {
  for (const bad of ["origin", "target", "snapshot", "time", "flags", "account"]) {
    const body = joinedBody();
    let parent = natParent();
    if (body.result.status !== "reported_subnets") throw new Error("Bad fixture");
    const last = body.result.subnets[1];
    if (last?.lookup.status !== "reported" || last.lookup.lookup.status !== "reported_route")
      throw new Error("Bad row");
    if (bad === "origin") last.lookup.lookup.origin = "";
    if (bad === "target") last.lookup.lookup.target = { kind: "nat_gateway", id: "" };
    if (bad === "snapshot") parent = { ...parent, snapshot: { ...parent.snapshot, id: "source-snapshot" } };
    if (bad === "time") parent = { ...parent, snapshot: { ...parent.snapshot, completed_at: "2" } };
    if (bad === "flags") parent = { ...parent, snapshot: { ...parent.snapshot, execution_enabled: true } };
    if (bad === "account") parent = { ...parent, snapshot: { ...parent.snapshot, account_id: "" } };
    const fieldset = renderTargetEntries(
      context,
      0,
      async () => body,
      () => true,
      parent,
    );
    choose(fieldset);
    click(fieldset);
    await finished(fieldset);
    expect(fieldset.querySelector("fieldset[data-nat-reference]")).toBeNull();
    expect(status(fieldset)).not.toContain("Saved target subnet");
  }
});
it("retired target NAT replies and retained actions cannot populate or unlock a newer child", async () => {
  for (const retirement of ["resubmit", "input", "ABA", "parent"])
    for (const rejected of [false, true]) {
      const pending: {
        query: VpcLookupRequest;
        resolve: (body: NatReferenceResponse) => void;
        reject: (error: Error) => void;
      }[] = [];
      let live = true;
      const fieldset = renderTargetEntries(
        context,
        0,
        async () => joinedBody(),
        () => live,
        natParent((query) => new Promise((resolve, reject) => pending.push({ query, resolve, reject }))),
      );
      const select = choose(fieldset);
      click(fieldset);
      await finished(fieldset);
      const child = fieldset.querySelector<HTMLFieldSetElement>("fieldset[data-nat-reference]"),
        action = child?.querySelector("button");
      if (!child || !action) throw new Error("Missing child");
      action.click();
      if (retirement === "parent") live = false;
      else if (retirement === "resubmit") {
        click(fieldset);
        await finished(fieldset);
      } else {
        select.value = "target-b";
        select.dispatchEvent(new Event("input"));
        if (retirement === "ABA") {
          select.value = "target-a";
          select.dispatchEvent(new Event("change"));
        }
      }
      action.disabled = false;
      action.click();
      expect(pending).toHaveLength(1);
      if (retirement === "resubmit")
        fieldset.querySelector<HTMLButtonElement>("fieldset[data-nat-reference] button")?.click();
      const old = pending[0];
      if (!old) throw new Error("Missing pending");
      if (rejected) old.reject(new Error("obsolete NAT failure"));
      else old.resolve(natBody(old.query));
      await new Promise((done) => setTimeout(done, 0));
      expect(child.querySelector("details")).toBeNull();
      expect(child.textContent).not.toContain("obsolete NAT failure");
      if (retirement === "resubmit") {
        const next = fieldset.querySelector<HTMLFieldSetElement>("fieldset[data-nat-reference]");
        expect(next?.querySelector("button")?.disabled).toBe(true);
        expect(next?.textContent).toContain("Reading saved NAT");
        const current = pending[1];
        if (!current) throw new Error("Missing newer pending");
        current.resolve(natBody(current.query));
        await new Promise((done) => setTimeout(done, 0));
        expect(next?.textContent).toContain("Referenced saved NAT record:");
      }
    }
});
function click(fieldset: HTMLFieldSetElement) {
  fieldset.querySelector("button")?.click();
}
it("rejects A's envelope or inconsistent owner scope through the composition but permits literal different ownership", async () => {
  for (const fault of ["account", "time", "entry", "scope", "different"]) {
    const fieldset = renderTargetEntries(
      context,
      0,
      async () => joinedBody(),
      () => true,
      natParent(async (query) => {
        const body = natBody(query);
        if (fault === "account") body.account_id = "source-registration";
        if (fault === "time") body.completed_at = "2";
        if (fault === "entry" && body.result.subnet_lookup.status === "reported")
          body.result.subnet_lookup.route_table_id = "other";
        if (body.result.reference.status === "reported_record" && ["scope", "different"].includes(fault)) {
          body.result.reference.resource.owner_account_id = "123456789012";
          if (fault === "different") body.result.reference.owner_scope = "reported_different";
        }
        return body;
      }),
    );
    choose(fieldset);
    click(fieldset);
    await finished(fieldset);
    const child = fieldset.querySelector<HTMLFieldSetElement>("fieldset[data-nat-reference]");
    if (!child) throw new Error("Missing child");
    child.querySelector("button")?.click();
    await new Promise((done) => setTimeout(done, 0));
    expect(status(fieldset)).toContain("Saved target subnet");
    if (fault === "different") {
      expect(child.textContent).toContain("reported_different");
      expect(child.querySelector("details")).not.toBeNull();
    } else {
      expect(child.querySelector("details")).toBeNull();
      expect(child.textContent).toContain("did not match");
    }
  }
});
it("retained metadata continuations inherit target retirement without another query or appended tuples", async () => {
  const fieldset = renderTargetEntries(
    context,
    0,
    async () => joinedBody(),
    () => true,
    natParent(async (query) => {
      const body = natBody(query);
      if (body.result.reference.status !== "reported_record") throw new Error("Bad fixture");
      body.result.reference.resource.nat_gateway = {
        route_table_id: "literal",
        addresses: Array.from({ length: 101 }, () => ({
          allocation_id: null,
          association_id: null,
          network_interface_id: null,
          public_ip: null,
          private_ip: null,
          az_name: null,
          az_id: null,
          is_primary: null,
          status: "failed",
        })),
      };
      return body;
    }),
  );
  const select = choose(fieldset);
  click(fieldset);
  await finished(fieldset);
  const child = fieldset.querySelector<HTMLFieldSetElement>("fieldset[data-nat-reference]");
  if (!child) throw new Error("Missing child");
  child.querySelector("button")?.click();
  await new Promise((done) => setTimeout(done, 0));
  const detail = child.querySelector("details");
  if (!detail) throw new Error("Missing metadata");
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
  expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(50);
  const more = detail.querySelector<HTMLButtonElement>("button[data-nat-more]");
  select.value = "target-b";
  select.dispatchEvent(new Event("change"));
  more?.click();
  detail.open = false;
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
  expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(50);
  expect(fieldset.querySelector("fieldset[data-nat-reference]")).toBeNull();
});
const status = (fieldset: HTMLFieldSetElement) => fieldset.querySelector('[role="status"]')?.textContent;
async function finished(fieldset: HTMLFieldSetElement) {
  await expect.poll(() => status(fieldset)).not.toContain("Reading saved");
  expect(fieldset.querySelector("button")?.disabled).toBe(false);
  return status(fieldset);
}
it("requires an explicit reported reference, uses a button not a nested form, and shows every subnet as unselected metadata", async () => {
  const callback = vi.fn(async () => value);
  const fieldset = renderTargetEntries(context, 0, callback, () => true);
  click(fieldset);
  expect(callback).not.toHaveBeenCalled();
  expect(status(fieldset)).toContain("Select a reported target attachment");
  const select = choose(fieldset);
  expect(select.required).toBe(false);
  expect(fieldset.querySelector("button")?.type).toBe("button");
  expect(fieldset.querySelector("form")).toBeNull();
  click(fieldset);
  await finished(fieldset);
  expect(callback).toHaveBeenCalledWith({
    transit_gateway_id: "tgw-network",
    target_attachment_id: "target-a",
    destination: "203.0.113.1",
  });
  for (const text of [
    "subnet-a",
    "subnet-b",
    "euw1-az1",
    "euw1-az2",
    "<img src=x>",
    "Reported target blackhole",
    "network-snapshot",
    "traffic AZ is not inferred",
    "connectivity remain untested",
  ])
    expect(status(fieldset)).toContain(text);
  expect(fieldset.querySelector("img")).toBeNull();
});
it("target choice retirement including ABA restores controls and fences old settlement from a newer request", async () => {
  for (const chosen of ["target-a", "target-b"])
    for (const rejected of [false, true]) {
      const pending: { resolve: (body: TgwTargetResponse) => void; reject: (error: Error) => void }[] = [];
      const fieldset = renderTargetEntries(
        context,
        0,
        () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
        () => true,
      );
      const select = choose(fieldset),
        button = fieldset.querySelector("button");
      if (!button) throw new Error("Missing action");
      click(fieldset);
      click(fieldset);
      expect(pending).toHaveLength(1);
      select.value = "target-b";
      select.dispatchEvent(new Event("change"));
      select.value = chosen;
      select.dispatchEvent(new Event("change"));
      expect(button.disabled).toBe(false);
      expect(select.disabled).toBe(false);
      click(fieldset);
      click(fieldset);
      expect(pending).toHaveLength(2);
      const old = pending[0],
        next = pending[1];
      if (!old || !next) throw new Error("Missing deferred replies");
      if (rejected) old.reject(new Error("obsolete target failure"));
      else old.resolve(value);
      await new Promise((done) => setTimeout(done, 0));
      expect(status(fieldset)).toContain("Reading saved");
      expect(button.disabled).toBe(true);
      expect(select.disabled).toBe(true);
      next.resolve({ ...value, target_attachment_id: chosen });
      expect(await finished(fieldset)).toContain("Saved target subnet");
      expect(status(fieldset)).not.toContain("obsolete target failure");
    }
});
it("target eventless completion retires evidence with refresh guidance and restores only its controls", async () => {
  for (const rejected of [false, true]) {
    let resolve!: (body: TgwTargetResponse) => void, reject!: (error: Error) => void;
    const fieldset = renderTargetEntries(
      context,
      0,
      () =>
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        }),
      () => true,
    );
    const select = choose(fieldset);
    click(fieldset);
    select.value = "target-b";
    if (rejected) reject(new Error("obsolete target failure"));
    else resolve(value);
    expect(await finished(fieldset)).toContain("run another saved lookup");
    expect(status(fieldset)).not.toContain("Saved target subnet");
    expect(select.disabled).toBe(false);
  }
});
it("rejects changed time/gateway/reference/destination, absent flags or AZ marker, and malformed/partial subnet shapes", async () => {
  if (value.result.status !== "reported_subnets") throw new Error("Bad fixture");
  const rows = value.result.subnets;
  const first = rows[0];
  if (!first) throw new Error("Missing fixture row");
  for (const body of [
    { ...value, completed_at: "5" },
    { ...value, transit_gateway_id: "other" },
    { ...value, target_attachment_id: "target-b" },
    { ...value, destination: "other" },
    { ...value, execution_enabled: undefined },
    { ...value, connectivity_tested: null },
    { ...value, connectivity_tested: true },
    { ...value, az_selection: undefined },
    { ...value, az_selection: "selected" },
    { ...value, result: { status: "future" } },
    { ...value, result: { ...value.result, subnets: [] } },
    { ...value, result: { ...value.result, subnets: [first, first] } },
    { ...value, result: { ...value.result, subnets: [first, { ...first, subnet_id: "different" }] } },
    { ...value, result: { ...value.result, subnets: [{ ...first, lookup: { status: "future" } }] } },
    {
      ...value,
      result: {
        ...value.result,
        subnets: Array.from({ length: 33 }, (_, index) => ({
          ...first,
          subnet_id: `subnet-${index}`,
          az_id: `euw1-az${index}`,
        })),
      },
    },
  ]) {
    const fieldset = render(body);
    choose(fieldset);
    click(fieldset);
    expect(await finished(fieldset)).toContain("did not match");
    expect(status(fieldset)).not.toContain("Saved target subnet");
  }
  const changed = render({ ...value, topology_id: "newer" });
  choose(changed);
  click(changed);
  expect(await finished(changed)).toContain("Snapshot changed; refresh");
});
it("excludes duplicate requests and restores retry after failure", async () => {
  const callback = vi
    .fn<() => Promise<TgwTargetResponse>>()
    .mockRejectedValueOnce(new Error("fixture failure"))
    .mockResolvedValue(value);
  const fieldset = renderTargetEntries(context, 0, callback, () => true);
  choose(fieldset);
  click(fieldset);
  click(fieldset);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(await finished(fieldset)).toContain("fixture failure");
  click(fieldset);
  expect(await finished(fieldset)).toContain("subnet-a");
  expect(callback).toHaveBeenCalledTimes(2);
});
it("target current discard restores controls for a fresh retry", async () => {
  let calls = 0;
  const fieldset = renderTargetEntries(
    context,
    0,
    async () => (++calls === 1 ? undefined : value),
    () => true,
  );
  choose(fieldset);
  click(fieldset);
  expect(await finished(fieldset)).toContain("discarded");
  click(fieldset);
  expect(await finished(fieldset)).toContain("Saved target subnet");
  expect(calls).toBe(2);
});
it("discards a pending target after parent invalidation or a changed attachment choice", async () => {
  for (const change of ["parent", "choice"]) {
    let resolve!: (value: TgwTargetResponse) => void;
    const pending = new Promise<TgwTargetResponse>((done) => {
      resolve = done;
    });
    let active = true;
    const callback = vi.fn(() => pending);
    const fieldset = renderTargetEntries(context, 0, callback, () => active);
    const select = choose(fieldset);
    click(fieldset);
    if (change === "parent") active = false;
    else {
      select.value = "target-b";
      select.dispatchEvent(new Event("change"));
    }
    resolve(value);
    await finished(fieldset);
    expect(status(fieldset)).not.toContain("subnet-a");
    if (change === "parent") {
      click(fieldset);
      expect(callback).toHaveBeenCalledTimes(1);
    }
  }
});
it("keeps unresolved scope and association/entry evidence distinct without a selected AZ", async () => {
  const unresolved = render({
    ...value,
    result: { status: "unresolved", reason: "attachment_subnet_unresolved" },
  });
  choose(unresolved);
  click(unresolved);
  expect(await finished(unresolved)).toContain("attachment_subnet_unresolved");
  const fieldset = render({
    ...value,
    result: {
      status: "reported_subnets",
      vpc_id: "vpc-target",
      subnets: [
        {
          subnet_id: "subnet-a",
          az_id: "euw1-az1",
          lookup: { status: "association_unresolved", reason: "association_not_ready" },
        },
        {
          subnet_id: "subnet-b",
          az_id: "euw1-az2",
          lookup: { status: "unresolved", reason: "scope_not_ready" },
        },
      ],
    },
  });
  choose(fieldset);
  click(fieldset);
  expect(await finished(fieldset)).toContain("association_not_ready");
  expect(status(fieldset)).toContain("scope_not_ready");
});

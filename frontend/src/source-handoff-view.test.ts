import { expect, it, vi } from "vitest";
import type {
  RouteTableSelection,
  TgwSourceResponse,
  TgwTargetResponse,
  VpcLookupRequest,
  VpcLookupResponse,
} from "./generated";
import { renderSourceHandoff, type SavedNetworkTargetLookup } from "./source-handoff-view";

// Renderer-only malformed/deferred HTTP fixtures, not backend/AWS acceptance.
const selection: RouteTableSelection = {
  status: "selected",
  route_table_id: "rtb-source",
  source: "implicit_main",
};
const value: TgwSourceResponse = {
  source_topology_id: "source-snapshot",
  network_topology_id: "network-snapshot",
  source_completed_at: "2",
  network_completed_at: "4",
  network_account_id: "network",
  subnet_id: "subnet-source",
  destination: "203.0.113.1",
  execution_enabled: false,
  connectivity_tested: false,
  result: {
    source: {
      status: "reported",
      route_table_id: "rtb-source",
      source: "implicit_main",
      lookup: {
        status: "reported_route",
        destination_cidr: "0.0.0.0/0",
        origin: "CreateRoute",
        target: { kind: "transit_gateway", id: "tgw-network" },
      },
    },
    handoff: {
      status: "reported_candidate",
      transit_gateway_id: "tgw-network",
      ingress_attachment_id: "<img src=x>",
      attachment_subnet_id: "subnet-attachment",
      az_id: "euw1-az1",
      route_table_id: "tgw-table",
      lookup: {
        status: "reported_forward",
        destination_cidr: "0.0.0.0/0",
        route_type: "static",
        attachment_ids: ["egress"],
      },
    },
  },
};
function render(
  lookup = async () => value as TgwSourceResponse | undefined,
  lookupTarget?: SavedNetworkTargetLookup,
) {
  const form = renderSourceHandoff(
    "source-snapshot",
    "subnet-source",
    selection,
    0,
    [
      { id: "network", name: "Network <img src=x>", region: "eu-west-1" },
      { id: "other", name: "Other", region: "eu-west-1" },
    ],
    lookup,
    lookupTarget,
  );
  const select = form.querySelector("select");
  const input = form.querySelector("input");
  if (!select || !input) throw new Error("Missing controls");
  select.value = "network";
  input.value = "203.0.113.1";
  return form;
}
function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}
const status = (form: HTMLFormElement) => form.querySelector('[role="status"]')?.textContent;
async function finished(form: HTMLFormElement) {
  await expect.poll(() => status(form)).not.toContain("Reading saved");
  expect(
    [...form.querySelectorAll<HTMLInputElement>("input,select,button")].every((control) => !control.disabled),
  ).toBe(true);
  return status(form);
}
function attachmentContext(
  lookup = async (query: VpcLookupRequest): Promise<VpcLookupResponse | undefined> => ({
    ...query,
    topology_id: "source-snapshot",
    execution_enabled: false,
    connectivity_tested: false,
    result: {
      status: "reported",
      route_table_id: "rtb-source-attachment",
      source: "explicit_subnet",
      lookup: {
        status: "reported_route",
        destination_cidr: "10.10.0.0/16",
        origin: "CreateRouteTable",
        target: { kind: "local" },
      },
    },
  }),
) {
  return {
    snapshot: {
      id: "source-snapshot",
      account_id: "source-account",
      completed_at: "2",
      execution_enabled: false,
      connectivity_tested: false,
    },
    subnetRouteTables: [
      { subnet_id: "subnet-source", vpc_id: "vpc-source", selection: { ...selection } },
      {
        subnet_id: "subnet-attachment",
        vpc_id: "vpc-source",
        selection: {
          status: "selected",
          route_table_id: "rtb-source-attachment",
          source: "explicit_subnet",
        } as RouteTableSelection,
      },
    ],
    lookup,
  };
}
it("explicitly inspects the source attachment subnet toward a separately supplied IP without reusing the outbound destination", async () => {
  const context = attachmentContext(),
    lookup = vi.fn(context.lookup);
  const form = renderSourceHandoff(
    "source-snapshot",
    "subnet-source",
    selection,
    0,
    [{ id: "network", name: "Network", region: "eu-west-1" }],
    async () => structuredClone(value),
    undefined,
    { sourceVpc: { ...context, lookup } },
  );
  const network = form.querySelector("select"),
    destination = form.querySelector("input");
  if (!network || !destination) throw new Error("Missing source controls");
  network.value = "network";
  destination.value = value.destination;
  submit(form);
  await finished(form);
  const children = form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-source-attachment-entry]");
  expect(children).toHaveLength(1);
  const child = children[0];
  if (!child) throw new Error("Missing attachment diagnostic");
  const input = child.querySelector("input"),
    button = child.querySelector("button");
  if (!input || !button) throw new Error("Missing point lookup controls");
  expect(input.value).toBe("");
  expect(input.required).toBe(false);
  expect(form.checkValidity()).toBe(true);
  expect(lookup).not.toHaveBeenCalled();
  button.click();
  expect(lookup).not.toHaveBeenCalled();
  input.value = "10.10.254.10";
  button.click();
  await expect.poll(() => child.textContent).toContain("Reported attachment-subnet entry");
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    subnet_id: "subnet-attachment",
    destination: "10.10.254.10",
  });
  for (const literal of [
    "rtb-source-attachment",
    "explicit_subnet",
    "source-account",
    "completed 2",
    "203.0.113.1",
    "10.10.254.10",
    "operator-supplied",
    "not a validated return path",
  ])
    expect(child.textContent).toContain(literal);
  expect(child.querySelector("form")).toBeNull();
  expect(child.querySelector("fieldset[data-nat-reference]")).toBeNull();
});
async function attachmentForm(ctx = attachmentContext(), reply = structuredClone(value)) {
  const form = renderSourceHandoff(
    "source-snapshot",
    "subnet-source",
    selection,
    0,
    [
      { id: "network", name: "Network", region: "eu-west-1" },
      { id: "other", name: "Other", region: "eu-west-1" },
    ],
    async () => structuredClone(reply),
    async () => targetNatFixture(),
    { sourceVpc: ctx },
  );
  const network = form.querySelector("select"),
    input = form.querySelector("input");
  if (!network || !input) throw new Error("Missing controls");
  network.value = "network";
  input.value = value.destination;
  submit(form);
  await finished(form);
  return { form, network, input };
}
it("unavailable source snapshot/table provenance disables only this child, not the accepted candidate/target branch", async () => {
  for (const fault of [
    "snapshot",
    "time",
    "account",
    "execution",
    "connectivity",
    "missing-row",
    "duplicate-candidate",
    "duplicate-source",
    "wrong-vpc",
    "selection",
    "source-selection",
  ]) {
    const ctx = attachmentContext();
    if (fault === "snapshot") ctx.snapshot.id = "other-snapshot";
    if (fault === "time") ctx.snapshot.completed_at = "3";
    if (fault === "account") ctx.snapshot.account_id = "";
    if (fault === "execution") Reflect.deleteProperty(ctx.snapshot, "execution_enabled");
    if (fault === "connectivity") ctx.snapshot.connectivity_tested = null as unknown as boolean;
    const candidate = ctx.subnetRouteTables[1],
      source = ctx.subnetRouteTables[0];
    if (!candidate || !source) throw new Error("Missing row");
    if (fault === "missing-row") ctx.subnetRouteTables.pop();
    if (fault === "duplicate-candidate") ctx.subnetRouteTables.push(structuredClone(candidate));
    if (fault === "duplicate-source") ctx.subnetRouteTables.push(structuredClone(source));
    if (fault === "wrong-vpc") candidate.vpc_id = "different";
    if (fault === "selection") Reflect.set(candidate.selection, "status", "future");
    if (fault === "source-selection" && source.selection.status === "selected")
      source.selection.route_table_id = "other";
    const { form } = await attachmentForm(ctx);
    expect(status(form)).toContain("Reported ingress candidate");
    expect(form.querySelector("fieldset[data-source-attachment-entry]")).toBeNull();
    expect(form.textContent).toContain("inspection unavailable");
    expect(form.querySelector("fieldset[data-target-entries]")).not.toBeNull();
  }
});
it("permits hypothetical inspection for a candidate with TGW blackhole, but never for an unresolved handoff", async () => {
  const reply = structuredClone(value);
  if (reply.result.handoff.status !== "reported_candidate") throw new Error("Missing candidate");
  reply.result.handoff.lookup = { status: "reported_blackhole", destination_cidr: "10.0.0.0/8" };
  const { form } = await attachmentForm(attachmentContext(), reply);
  expect(form.querySelector("fieldset[data-source-attachment-entry]")).not.toBeNull();
  expect(form.querySelector("fieldset[data-target-entries]")).toBeNull();
  const unresolved = structuredClone(value);
  unresolved.result.handoff = { status: "ingress_unresolved", reason: "missing_or_ambiguous_attachment" };
  expect(
    (await attachmentForm(attachmentContext(), unresolved)).form.querySelector(
      "fieldset[data-source-attachment-entry]",
    ),
  ).toBeNull();
});
it("source resubmit, change-only and network ABA remove a pending child and fence its retained success/error/action", async () => {
  for (const retirement of ["resubmit", "change", "network ABA"])
    for (const failed of [false, true]) {
      let resolve: (value: VpcLookupResponse | undefined) => void = () => {
        throw new Error("Missing resolver");
      };
      let reject: (error: Error) => void = () => {
        throw new Error("Missing rejecter");
      };
      const pending = new Promise<VpcLookupResponse | undefined>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const lookup = vi.fn(async () => pending);
      const { form, network, input } = await attachmentForm(attachmentContext(lookup));
      const child = form.querySelector("fieldset[data-source-attachment-entry]"),
        point = child?.querySelector("input"),
        action = child?.querySelector("button");
      if (!child || !point || !action) throw new Error("Missing child");
      point.value = "10.10.254.10";
      action.click();
      expect(point.disabled).toBe(true);
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
      expect(form.querySelector<HTMLSelectElement>("fieldset[data-target-entries] select")?.disabled).toBe(
        false,
      );
      if (retirement === "resubmit") submit(form);
      else if (retirement === "change") {
        input.value = "203.0.113.2";
        input.dispatchEvent(new Event("change"));
      } else {
        network.value = "other";
        network.dispatchEvent(new Event("input"));
        network.value = "network";
        network.dispatchEvent(new Event("change"));
      }
      expect(child.textContent).toBe("");
      if (failed) reject(new Error("obsolete attachment failure"));
      else
        resolve(
          await attachmentContext().lookup({ subnet_id: "subnet-attachment", destination: point.value }),
        );
      await new Promise((done) => setTimeout(done, 0));
      action.disabled = false;
      action.click();
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(form.textContent).not.toContain("Reported attachment-subnet entry");
      expect(form.textContent).not.toContain("obsolete attachment failure");
      if (retirement === "resubmit") {
        const replacement = form.querySelector("fieldset[data-source-attachment-entry]");
        expect(replacement).not.toBe(child);
        expect(replacement?.querySelector("input")?.value).toBe("");
      }
    }
});
it("shows both independent snapshots and inert candidate metadata without a validated-path claim", async () => {
  const form = render();
  submit(form);
  expect(await finished(form)).toContain("Reported ingress candidate");
  for (const text of [
    "source-snapshot",
    "network-snapshot",
    "completed 2",
    "completed 4",
    "<img src=x>",
    "Independent saved observations",
    "not a validated path",
  ])
    expect(form.textContent).toContain(text);
  expect(form.querySelector("img")).toBeNull();
});
function targetNatFixture(): TgwTargetResponse {
  return {
    topology_id: "network-snapshot",
    completed_at: "4",
    transit_gateway_id: "tgw-network",
    target_attachment_id: "egress",
    destination: value.destination,
    az_selection: "not_inferred",
    execution_enabled: false,
    connectivity_tested: false,
    result: {
      status: "reported_subnets",
      vpc_id: "vpc-target",
      subnets: [
        {
          subnet_id: "subnet-target",
          az_id: "euw1-az1",
          lookup: {
            status: "reported",
            route_table_id: "rtb-network",
            source: "implicit_main",
            lookup: {
              status: "reported_route",
              destination_cidr: "0.0.0.0/0",
              origin: "CreateRoute",
              target: { kind: "nat_gateway", id: "nat-saved" },
            },
          },
        },
      ],
    },
  };
}
async function sourceNatFixture(awsId: unknown, duplicate = false) {
  let live = true;
  const calls: unknown[] = [];
  const account = {
    id: "network",
    name: "Network",
    region: "eu-west-1",
    aws_account_id: awsId as string | undefined,
  };
  const form = renderSourceHandoff(
    "source-snapshot",
    "subnet-source",
    selection,
    0,
    duplicate ? [account, { ...account }] : [account],
    async () => structuredClone(value),
    async () => targetNatFixture(),
    {
      isCurrent: () => live,
      lookupNatReference: async (id, query) => {
        calls.push({ id, query });
        return undefined;
      },
    },
  );
  // Caller mutation cannot replace already captured registration identity.
  account.id = "source-registration";
  account.aws_account_id = "123456789012";
  const network = form.querySelector("select"),
    input = form.querySelector("input");
  if (!network || !input) throw new Error("Missing controls");
  network.value = "network";
  input.value = value.destination;
  submit(form);
  await finished(form);
  const target = form.querySelector<HTMLFieldSetElement>("fieldset[data-target-entries]"),
    choice = target?.querySelector("select");
  if (!target || !choice) throw new Error("Missing target");
  choice.value = "egress";
  target.querySelector("button")?.click();
  await expect
    .poll(() => target.querySelector('[role="status"]')?.textContent)
    .toContain("Saved target subnet");
  return {
    form,
    target,
    calls,
    retire: () => {
      live = false;
    },
  };
}
it("captures B's registration for NAT reads without changing legacy Source/Target callers", async () => {
  const view = await sourceNatFixture("210987654321");
  const child = view.target.querySelector<HTMLFieldSetElement>("fieldset[data-nat-reference]");
  if (!child) throw new Error("Missing joined child");
  expect(view.calls).toHaveLength(0);
  expect(view.form.checkValidity()).toBe(true);
  child.querySelector("button")?.click();
  await expect.poll(() => child.textContent).toContain("discarded");
  expect(view.calls).toEqual([
    { id: "network", query: { subnet_id: "subnet-target", destination: value.destination } },
  ]);
  view.retire();
  child.querySelector("button")?.click();
  submit(view.form);
  expect(view.calls).toHaveLength(1);
});
it("missing malformed or ambiguous network AWS fields preserve target evidence without guessing NAT provenance", async () => {
  for (const awsId of [undefined, null, "", false, {}]) {
    const view = await sourceNatFixture(awsId);
    expect(view.target.querySelector("fieldset[data-nat-reference]")).toBeNull();
    expect(view.target.textContent).toContain("uniquely bound saved network AWS-account field");
    expect(view.calls).toHaveLength(0);
  }
  const duplicate = await sourceNatFixture("210987654321", true);
  expect(duplicate.target.querySelector("fieldset[data-nat-reference]")).toBeNull();
  expect(duplicate.target.textContent).toContain("uniquely bound");
});
it("source retirement including change-only and ABA restores controls and fences old settlement from a newer request", async () => {
  for (const change of ["input", "change", "network", "ABA"])
    for (const rejected of [false, true]) {
      const pending: { resolve: (body: TgwSourceResponse) => void; reject: (error: Error) => void }[] = [];
      const form = render(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
      const input = form.querySelector("input"),
        network = form.querySelector("select"),
        button = form.querySelector("button");
      if (!input || !network || !button) throw new Error("Missing source controls");
      submit(form);
      submit(form);
      expect(pending).toHaveLength(1);
      if (change === "network") {
        network.value = "other";
        network.dispatchEvent(new Event("change"));
      } else {
        input.value = "203.0.113.2";
        input.dispatchEvent(new Event(change === "change" ? "change" : "input"));
        if (change === "ABA") {
          input.value = value.destination;
          input.dispatchEvent(new Event("change"));
        }
      }
      expect(button.disabled).toBe(false);
      expect(input.disabled).toBe(false);
      expect(network.disabled).toBe(false);
      submit(form);
      submit(form);
      expect(pending).toHaveLength(2);
      const old = pending[0],
        next = pending[1];
      if (!old || !next) throw new Error("Missing deferred replies");
      if (rejected) old.reject(new Error("obsolete source failure"));
      else old.resolve(value);
      await new Promise((done) => setTimeout(done, 0));
      expect(status(form)).toContain("Reading saved");
      expect(button.disabled).toBe(true);
      expect(input.disabled).toBe(true);
      expect(network.disabled).toBe(true);
      next.resolve({ ...value, destination: input.value, network_account_id: network.value });
      expect(await finished(form)).toContain("Reported ingress candidate");
      expect(status(form)).not.toContain("obsolete source failure");
    }
});
it("source eventless completion retires evidence with refresh guidance and restores only its controls", async () => {
  for (const rejected of [false, true]) {
    let resolve!: (body: TgwSourceResponse) => void, reject!: (error: Error) => void;
    const form = render(
      () =>
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        }),
    );
    submit(form);
    const input = form.querySelector("input");
    if (!input) throw new Error("Missing destination");
    input.value = "203.0.113.2";
    if (rejected) reject(new Error("obsolete source failure"));
    else resolve(value);
    expect(await finished(form)).toContain("run another saved lookup");
    expect(status(form)).not.toContain("Reported ingress candidate");
    expect(form.querySelector("fieldset[data-target-entries]")).toBeNull();
  }
});
it("rejects mismatched scopes, omitted/non-false flags and inconsistent source/gateway evidence", async () => {
  const source = value.result.source,
    handoff = value.result.handoff;
  if (source.status !== "reported" || handoff.status !== "reported_candidate") throw new Error("Bad fixture");
  for (const body of [
    { ...value, result: { ...value.result, source: { ...source, source: "explicit_subnet" } } },
    { ...value, result: { ...value.result, source: { status: "future" } } },
    { ...value, result: { ...value.result, source: { ...source, lookup: { status: "future" } } } },
    { ...value, result: { ...value.result, handoff: { status: "future" } } },
    { ...value, result: { ...value.result, handoff: { ...handoff, lookup: { status: "future" } } } },
    { ...value, network_account_id: "other" },
    { ...value, subnet_id: "other" },
    { ...value, destination: "other" },
    { ...value, execution_enabled: undefined },
    { ...value, connectivity_tested: null },
    { ...value, execution_enabled: true },
    { ...value, network_topology_id: "" },
    { ...value, source_completed_at: undefined },
    { ...value, result: { ...value.result, source: { ...value.result.source, route_table_id: "other" } } },
    {
      ...value,
      result: { ...value.result, handoff: { ...value.result.handoff, transit_gateway_id: "tgw-other" } },
    },
  ]) {
    const form = render(async () => body as TgwSourceResponse);
    submit(form);
    expect(await finished(form)).toContain("did not match");
    expect(status(form)).not.toContain("Reported ingress candidate");
  }
  const form = render(async () => ({ ...value, source_topology_id: "new-snapshot" }));
  submit(form);
  expect(await finished(form)).toContain("Snapshot changed; refresh");
});
it("prevents duplicate submits and re-enables controls after a rejection so a reader can retry", async () => {
  const callback = vi
    .fn<() => Promise<TgwSourceResponse>>()
    .mockRejectedValueOnce(new Error("fixture failure"))
    .mockResolvedValue(value);
  const form = render(callback);
  submit(form);
  submit(form);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(await finished(form)).toContain("fixture failure");
  submit(form);
  expect(await finished(form)).toContain("Reported ingress candidate");
  expect(callback).toHaveBeenCalledTimes(2);
});
it("source current discard restores controls for a fresh retry", async () => {
  let calls = 0;
  const form = render(async () => (++calls === 1 ? undefined : value));
  submit(form);
  expect(await finished(form)).toContain("discarded");
  submit(form);
  expect(await finished(form)).toContain("Reported ingress candidate");
  expect(calls).toBe(2);
});
it("clears old results on input changes and discards a pending result after network selection changes", async () => {
  let resolve!: (value: TgwSourceResponse) => void;
  const pending = new Promise<TgwSourceResponse>((done) => {
    resolve = done;
  });
  const form = render(() => pending);
  submit(form);
  const select = form.querySelector("select");
  if (!select) throw new Error("Missing select");
  select.value = "other";
  select.dispatchEvent(new Event("change"));
  resolve(value);
  await finished(form);
  expect(status(form)).not.toContain("Reported ingress candidate");
  const next = render();
  submit(next);
  await finished(next);
  next.querySelector("input")?.dispatchEvent(new Event("input"));
  expect(status(next)).not.toContain("network-snapshot");
});
it("source resubmit and network/destination changes retire a pending target panel without a mixed result", async () => {
  for (const change of ["resubmit", "network", "destination"]) {
    let resolve!: (value: TgwTargetResponse) => void;
    const pending = new Promise<TgwTargetResponse>((done) => {
      resolve = done;
    });
    const callback = vi.fn(() => pending);
    const form = render(undefined, callback);
    submit(form);
    await finished(form);
    expect(form.checkValidity()).toBe(true);
    const target = form.querySelector<HTMLFieldSetElement>("fieldset[data-target-entries]");
    const choice = target?.querySelector("select");
    if (!target || !choice) throw new Error("Target panel missing");
    choice.value = "egress";
    target.querySelector("button")?.click();
    expect(callback).toHaveBeenCalledTimes(1);
    if (change === "resubmit") {
      submit(form);
      await finished(form);
    } else if (change === "network") {
      const select = form.querySelector("select");
      if (!select) throw new Error("Network choice missing");
      select.value = "other";
      select.dispatchEvent(new Event("change"));
    } else {
      const input = form.querySelector("input");
      if (!input) throw new Error("Destination missing");
      input.value = "203.0.113.8";
      input.dispatchEvent(new Event("input"));
    }
    resolve({
      topology_id: "network-snapshot",
      completed_at: "4",
      transit_gateway_id: "tgw-network",
      target_attachment_id: "egress",
      destination: "203.0.113.1",
      az_selection: "not_inferred",
      execution_enabled: false,
      connectivity_tested: false,
      result: { status: "unresolved", reason: "attachment_subnet_unresolved" },
    });
    await expect
      .poll(() => target.querySelector('[role="status"]')?.textContent)
      .not.toContain("Reading saved");
    expect(target.parentElement).toBeNull();
    expect(form.textContent).not.toContain("Target scope unresolved: attachment_subnet_unresolved");
    target.querySelector("button")?.click();
    expect(callback).toHaveBeenCalledTimes(1);
  }
});
it("does not submit an absent account selection", () => {
  const callback = vi.fn(async () => value);
  const form = render(callback);
  const select = form.querySelector("select");
  if (!select) throw new Error("Missing select");
  select.value = "";
  submit(form);
  expect(callback).not.toHaveBeenCalled();
  expect(status(form)).toContain("Select a saved network account");
});

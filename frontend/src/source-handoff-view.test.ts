import { expect, it, vi } from "vitest";
import type { RouteTableSelection, TgwSourceResponse, TgwTargetResponse } from "./generated";
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

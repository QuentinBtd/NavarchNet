import { expect, it, vi } from "vitest";
import type { TgwTargetResponse } from "./generated";
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
function click(fieldset: HTMLFieldSetElement) {
  fieldset.querySelector("button")?.click();
}
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

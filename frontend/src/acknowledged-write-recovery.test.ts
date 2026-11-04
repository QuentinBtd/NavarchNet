import { afterEach, expect, it, vi } from "vitest";
import type { Operation, Plan, Snapshot } from "./generated";

const plan = (id: string): Plan => ({
  id,
  scope: "app:vpc",
  scope_version: 0,
  inventory_revision: 1,
  network_revision: 1,
  request: {
    account_id: "app",
    vpc_id: "vpc",
    network_id: "network",
    subnet_ids: ["subnet-two"],
    allow_application_traffic: false,
  },
  actions: [{ kind: "attachment", target: "vpc", requires: [], postcondition: "Simulated attachment" }],
  digest: id,
});
const operation = (id: string, source: Plan): Operation => ({
  id,
  plan_id: source.id,
  scope: source.scope,
  status: "queued",
  step: 0,
  attempts: 0,
  error: null,
  fault: "none",
});
const state = (): Snapshot => ({
  accounts: [{ id: "app", name: "Application", provider: "fake", revision: 1, role_arn: "fake:role" }],
  inventory: [
    {
      account_id: "app",
      vpc_id: "vpc",
      region: "eu-west-1",
      cidr: "10.0.0.0/16",
      revision: 1,
      subnets: [
        { id: "subnet-one", az_id: "az-one", route_table: "rtb-one", default_route_managed: true },
        { id: "subnet-two", az_id: "az-two", route_table: "rtb-two", default_route_managed: true },
      ],
    },
  ],
  networks: [
    {
      id: "network",
      name: "Regional",
      region: "eu-west-1",
      revision: 1,
      egress_cidr: "10.250.0.0/16",
      az_ids: ["az-one", "az-two"],
      public_ips: [],
      application_cidrs: [],
      managed_nat: true,
    },
  ],
  plans: [plan("original-plan")],
  operations: [],
  mode: "demo",
  role: "admin",
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
async function boot(handler: (path: string, init?: RequestInit) => Promise<Response>) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/plans");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-admin";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
  await vi.waitFor(() => expect(document.querySelectorAll("#plan-list article")).toHaveLength(1));
}
function select(selector: string, id: string) {
  node<HTMLSelectElement>(selector).value = id;
  node(selector).dispatchEvent(new Event("change"));
}
async function navigate(selector: string, section: string) {
  node<HTMLAnchorElement>(selector).click();
  await vi.waitFor(() => expect(node(section).hidden).toBe(false));
}
const writes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
const notice = () => node("#notice").textContent ?? "";
const tick = () => new Promise((done) => setTimeout(done, 0));
afterEach(() => {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("distinguishes rejected generation from an acknowledged Plan whose history read failed, then recovers only explicitly", async () => {
  const data = state(),
    original = structuredClone(data.plans[0]),
    created = plan("acknowledged-plan"),
    applied = operation("explicit-operation", created);
  let failRead = false,
    creates = 0;
  await boot(async (path) => {
    if (path === "/api/v1/snapshot") {
      if (failRead) {
        failRead = false;
        return reply({ error: "Snapshot read unavailable" }, 503);
      }
      return reply(data);
    }
    if (path === "/api/v1/plans") {
      if (++creates === 1) return reply({ error: "Overlapping CIDRs prevent safe routing" }, 409);
      data.plans = [created, ...data.plans];
      failRead = true;
      return reply(created);
    }
    if (path === `/api/v1/plans/${created.id}/apply`) {
      data.operations = [applied];
      return reply(applied);
    }
    throw new Error(`Unexpected generation recovery request ${path}`);
  });
  select("#plan-selection", original.id);
  node<HTMLButtonElement>("[data-plan-reconfigure]").click();
  await vi.waitFor(() => expect(node("#connect").hidden).toBe(false));
  const submit = () => node("#plan-form").dispatchEvent(new Event("submit", { cancelable: true }));
  const originalPayload = original.request;
  expect(
    [...document.querySelectorAll<HTMLInputElement>("#subnets input:checked")].map((n) => n.value),
  ).toEqual(originalPayload.subnet_ids);
  expect(writes()).toHaveLength(0);
  submit();
  await vi.waitFor(() => expect(notice()).toBe("Overlapping CIDRs prevent safe routing"));
  expect(data.plans).toEqual([original]);
  expect(node<HTMLButtonElement>("#connection-configure button[data-write]").disabled).toBe(false);
  submit();
  await vi.waitFor(() => expect(notice()).toContain(created.id));
  expect(notice()).toContain("was created");
  expect(notice()).toContain("Refresh explicitly");
  expect(notice()).toContain("No Apply");
  expect(notice()).toContain("Snapshot read unavailable");
  expect(node("#connect").hidden).toBe(false);
  expect(node("#plan-list article").getAttribute("data-plan-id")).toBe(original.id);
  expect(node<HTMLButtonElement>("#connection-configure button[data-write]").disabled).toBe(false);
  expect(writes()).toHaveLength(2);
  expect(data.operations).toEqual([]);
  for (const [, init] of writes()) expect(JSON.parse(String(init?.body))).toEqual(originalPayload);
  const calls = vi.mocked(fetch).mock.calls.length;
  await tick();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  const oldSubnets = node("#subnets input");
  node<HTMLButtonElement>("#refresh").click();
  await vi.waitFor(() => expect(oldSubnets.isConnected).toBe(false));
  expect(node("#plan-list article").getAttribute("data-plan-id")).toBe(original.id);
  await navigate('#connect a[href="#/plans"]', "#plans");
  select("#plan-selection", created.id);
  expect(JSON.parse(node("#plan-list article details pre").textContent ?? "null")).toEqual(created);
  expect(data.plans.find((p) => p.id === original.id)).toEqual(original);
  expect(writes()).toHaveLength(2);
  node<HTMLButtonElement>("#plan-list article button[data-write]").click();
  await vi.waitFor(() => expect(node("#operations").hidden).toBe(false));
  expect(node("#operation-list article").getAttribute("data-operation-id")).toBe(applied.id);
  expect(writes()).toHaveLength(3);
  expect(writes()[2]?.[0]).toBe(`/api/v1/plans/${created.id}/apply`);
  expect(data.plans.find((p) => p.id === original.id)).toEqual(original);
});

it("retains an acknowledged Apply identity after its history read fails without implying retry or rollback", async () => {
  const data = state(),
    original = data.plans[0],
    previousPlan = plan("previous-plan");
  original.scope_version = 1;
  const previous = { ...operation("previous-operation", previousPlan), status: "succeeded", step: 1 },
    acknowledged = operation("acknowledged-operation", original),
    immutable = structuredClone(original);
  data.plans.push(previousPlan);
  data.operations = [previous];
  let failRead = false;
  await boot(async (path) => {
    if (path === "/api/v1/snapshot") {
      if (failRead) {
        failRead = false;
        return reply({ error: "Operation history unavailable" }, 503);
      }
      return reply(data);
    }
    if (path === `/api/v1/plans/${original.id}/apply`) {
      data.operations = [acknowledged, previous];
      failRead = true;
      return reply(acknowledged);
    }
    throw new Error(`Unexpected apply recovery request ${path}`);
  });
  const oldApply = node<HTMLButtonElement>("#plan-list article button[data-write]");
  oldApply.click();
  await vi.waitFor(() => expect(notice()).toContain(acknowledged.id));
  expect(notice()).toContain("Apply acknowledged operation");
  expect(notice()).toContain("may continue");
  expect(notice()).toContain("Refresh explicitly");
  expect(notice()).toContain("Operation history unavailable");
  expect(node("#plans").hidden).toBe(false);
  expect(oldApply.disabled).toBe(false);
  expect(node("#plan-list article").getAttribute("data-plan-id")).toBe(original.id);
  expect(node("#operation-list article").getAttribute("data-operation-id")).toBe(previous.id);
  expect(writes()).toHaveLength(1);
  expect(data.plans[0]).toEqual(immutable);
  const calls = vi.mocked(fetch).mock.calls.length;
  await tick();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  node<HTMLButtonElement>("#refresh").click();
  await vi.waitFor(() => expect(oldApply.isConnected).toBe(false));
  expect(node("#operation-list article").getAttribute("data-operation-id")).toBe(previous.id);
  await navigate('nav[aria-label="Workspace"] a[href="#/operations"]', "#operations");
  select("#operation-selection", acknowledged.id);
  expect(node("#operation-list article").getAttribute("data-operation-id")).toBe(acknowledged.id);
  expect(JSON.parse(node("#operation-list article details pre").textContent ?? "null")).toEqual(acknowledged);
  expect(writes()).toHaveLength(1);
  expect(data.plans[0]).toEqual(immutable);
});

it("retires acknowledged followup failures without exposing old identities or unlocking newer generation", async () => {
  for (const kind of ["plan", "operation"] as const) {
    for (const retirement of ["navigation", "refresh", "relogin"]) {
      const data = state(),
        oldPlan = plan("retired-acknowledged-plan"),
        oldOperation = operation("retired-acknowledged-operation", data.plans[0]),
        freshPlan = plan("current-pending-plan");
      let releaseOld!: (response: Response) => void, releaseFresh!: (response: Response) => void;
      const oldRead = new Promise<Response>((done) => {
        releaseOld = done;
      });
      const freshWrite = new Promise<Response>((done) => {
        releaseFresh = done;
      });
      let reads = 0,
        posts = 0;
      await boot(async (path, init) => {
        if (path === "/api/v1/snapshot") return ++reads === 2 ? oldRead : reply(data);
        if (
          path === "/api/v1/plans" ||
          path === `/api/v1/plans/${data.plans.find((p) => p.id === "original-plan")?.id}/apply`
        ) {
          if (++posts === 1) {
            if (kind === "plan") data.plans = [oldPlan, ...data.plans];
            else data.operations = [oldOperation];
            return reply(kind === "plan" ? oldPlan : oldOperation);
          }
          freshPlan.request = JSON.parse(String(init?.body));
          return freshWrite;
        }
        throw new Error(`Unexpected retirement request ${path}`);
      });
      select("#plan-selection", "original-plan");
      if (kind === "plan") {
        node<HTMLButtonElement>("[data-plan-reconfigure]").click();
        await vi.waitFor(() => expect(node("#connect").hidden).toBe(false));
        node("#plan-form").dispatchEvent(new Event("submit", { cancelable: true }));
      } else node<HTMLButtonElement>("#plan-list article button[data-write]").click();
      await vi.waitFor(() => expect(reads).toBe(2));
      if (retirement === "refresh") {
        const oldRoot = node("#plan-list article");
        node<HTMLButtonElement>("#refresh").click();
        await vi.waitFor(() => expect(oldRoot.isConnected).toBe(false));
      } else if (retirement === "navigation") {
        await navigate('nav[aria-label="Workspace"] a[href="#/overview"]', "#overview");
      } else {
        node<HTMLButtonElement>("#logout").click();
        node<HTMLInputElement>("#token").value = "fixture-admin";
        node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
        await vi.waitFor(() => expect(node("#workspace").hidden).toBe(false));
        await vi.waitFor(() => expect(reads).toBe(3));
      }
      await navigate('nav[aria-label="Workspace"] a[href="#/connections"]', "#connect");
      if (node("#connection-configure").hidden) node<HTMLButtonElement>("#configure-connection").click();
      await vi.waitFor(() => expect(node("#connection-configure").hidden).toBe(false));
      node("#plan-form").dispatchEvent(new Event("submit", { cancelable: true }));
      expect(posts).toBe(2);
      const current = node<HTMLButtonElement>("#connection-configure button[data-write]"),
        calls = vi.mocked(fetch).mock.calls.length;
      const late = reply({ error: "Obsolete acknowledged-history failure" }, 503);
      releaseOld(late);
      await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
      await tick();
      expect(notice()).toBe("Working…");
      expect(current.disabled).toBe(true);
      expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
      data.plans = [freshPlan, ...data.plans];
      releaseFresh(reply(freshPlan));
      await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
      expect(node("#plan-list article").getAttribute("data-plan-id")).toBe(freshPlan.id);
      expect(posts).toBe(2);
      node<HTMLButtonElement>("#logout").click();
    }
  }
});

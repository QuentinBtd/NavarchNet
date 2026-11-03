import { afterEach, expect, it, vi } from "vitest";
import type { Plan, Snapshot } from "./generated";

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
  digest: id === "original" ? "a".repeat(64) : "b".repeat(64),
});
const state = (): Snapshot => ({
  accounts: [{ id: "app", name: "Application", provider: "fake", revision: 1, role_arn: "fake:role" }],
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
  plans: [plan("original")],
  operations: [],
  mode: "demo",
  role: "admin",
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}
afterEach(() => {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("admits one pending explicit generation from the original request through exact Plan review and operation handoff", async () => {
  vi.resetModules();
  const data = state(),
    original = structuredClone(data.plans[0]),
    generated = plan("generated");
  const posts: { path: string; body: unknown }[] = [];
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const operation: Snapshot["operations"][number] = {
    id: "generated-operation",
    plan_id: generated.id,
    scope: generated.scope,
    status: "queued",
    step: 0,
    attempts: 0,
    error: null,
    fault: "none",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/snapshot") return reply(data);
      posts.push({ path, body: JSON.parse(String(init?.body)) });
      if (path === "/api/v1/plans") return pending;
      if (path === `/api/v1/plans/${generated.id}/apply`) {
        data.operations = [operation];
        return reply(operation);
      }
      throw new Error(`Unexpected generation request ${path}`);
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/plans");
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-admin";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe(original.id),
  );
  const prepare = node<HTMLButtonElement>("#plan-list [data-plan-reconfigure]");
  expect(prepare.disabled).toBe(false);
  prepare.click();
  await vi.waitFor(() => expect(node("#connect").hidden).toBe(false));
  expect(node("#connection-configure").hidden).toBe(false);
  expect(
    [...document.querySelectorAll<HTMLInputElement>("#subnets input:checked")].map((n) => n.value),
  ).toEqual(original.request.subnet_ids);
  expect(posts).toEqual([]);
  const submit = () => node("#plan-form").dispatchEvent(new Event("submit", { cancelable: true }));
  try {
    submit();
    expect(posts).toEqual([{ path: "/api/v1/plans", body: original.request }]);
    const pendingNotice = node("#notice").textContent;
    submit();
    expect(posts).toHaveLength(1);
    expect(node("#notice").textContent).toBe(pendingNotice);
    data.plans = [generated, data.plans[0]];
    resolve(reply(generated));
    await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
    expect(node("#plan-list article").getAttribute("data-plan-id")).toBe(generated.id);
    expect(JSON.parse(node("#plan-list article details pre").textContent ?? "null")).toEqual(generated);
    expect(data.plans.find((p) => p.id === original.id)).toEqual(original);
    expect(posts).toHaveLength(1);
    node<HTMLButtonElement>("#plan-list article button[data-write]").click();
    await vi.waitFor(() => expect(node("#operations").hidden).toBe(false));
    expect(node("#operation-list article").getAttribute("data-operation-id")).toBe(operation.id);
    expect(posts).toEqual([
      { path: "/api/v1/plans", body: original.request },
      { path: `/api/v1/plans/${generated.id}/apply`, body: { fault: "none" } },
    ]);
    expect(data.plans.find((p) => p.id === original.id)).toEqual(original);
  } finally {
    document.querySelector<HTMLButtonElement>("#logout")?.click();
    resolve(reply(generated));
  }
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function configure(data: Snapshot, handler: (path: string, init?: RequestInit) => Promise<Response>) {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/connections");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-admin";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(node("#connect").hidden).toBe(false));
  node<HTMLButtonElement>("#configure-connection").click();
  await vi.waitFor(() => expect(node("#connection-configure").hidden).toBe(false));
  expect(node<HTMLSelectElement>("#network").value).toBe(data.networks[0].id);
  const first = node<HTMLInputElement>("#subnets input");
  first.checked = false;
  first.dispatchEvent(new Event("change"));
}
const generateControl = () => node<HTMLButtonElement>("#connection-configure button[data-write]");
const submitGeneration = () => node("#plan-form").dispatchEvent(new Event("submit", { cancelable: true }));

it("requires explicit retry after failure and keeps the followup snapshot inside the generation admission", async () => {
  const data = state(),
    generated = plan("retry"),
    post = deferredResponse(),
    followup = deferredResponse();
  let posts = 0,
    reads = 0;
  await configure(data, async (path) => {
    if (path === "/api/v1/snapshot") return ++reads === 1 ? reply(data) : followup.promise;
    if (path === "/api/v1/plans")
      return ++posts === 1 ? reply({ error: "Explicit retry fixture refusal" }, 409) : post.promise;
    throw new Error(`Unexpected retry path ${path}`);
  });
  submitGeneration();
  await vi.waitFor(() => expect(node("#notice").textContent).toContain("Explicit retry fixture refusal"));
  expect(generateControl().disabled).toBe(false);
  expect(posts).toBe(1);
  submitGeneration();
  expect(posts).toBe(2);
  expect(generateControl().disabled).toBe(true);
  data.plans = [generated, ...data.plans];
  post.resolve(reply(generated));
  await vi.waitFor(() => expect(reads).toBe(2));
  submitGeneration();
  submitGeneration();
  expect(posts).toBe(2);
  expect(generateControl().disabled).toBe(true);
  followup.resolve(reply(data));
  await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
  expect(node("#plan-list article").getAttribute("data-plan-id")).toBe(generated.id);
  expect(data.operations).toEqual([]);
});

it("retired generation success or failure cannot unlock a newer pending generation after edits, refresh, navigation or relogin", async () => {
  for (const retirement of ["edit", "refresh", "navigation", "relogin"]) {
    for (const failed of [false, true]) {
      const data = state(),
        old = deferredResponse(),
        fresh = deferredResponse(),
        generated = plan("current");
      let posts = 0;
      await configure(data, async (path, init) => {
        if (path === "/api/v1/snapshot") return reply(data);
        if (path === "/api/v1/plans") {
          if (++posts === 1) return old.promise;
          generated.request = JSON.parse(String(init?.body));
          return fresh.promise;
        }
        throw new Error(`Unexpected retirement path ${path}`);
      });
      submitGeneration();
      expect(posts).toBe(1);
      expect(generateControl().disabled).toBe(true);
      if (retirement === "edit") {
        const first = node<HTMLInputElement>("#subnets input");
        first.checked = true;
        first.dispatchEvent(new Event("change"));
      } else if (retirement === "refresh") {
        const checkbox = node("#subnets input");
        node<HTMLButtonElement>("#refresh").click();
        await vi.waitFor(() => expect(checkbox.isConnected).toBe(false));
      } else if (retirement === "navigation") {
        node<HTMLAnchorElement>('nav a[href="#/overview"]').click();
        await vi.waitFor(() => expect(node("#overview").hidden).toBe(false));
        node<HTMLAnchorElement>('nav a[href="#/connections"]').click();
        await vi.waitFor(() => expect(node("#connect").hidden).toBe(false));
      } else {
        node<HTMLButtonElement>("#logout").click();
        node<HTMLInputElement>("#token").value = "fixture-admin";
        node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
        await vi.waitFor(() => expect(node("#connect").hidden).toBe(false));
        node<HTMLButtonElement>("#configure-connection").click();
        await vi.waitFor(() => expect(node("#connection-configure").hidden).toBe(false));
      }
      expect(generateControl().disabled).toBe(false);
      submitGeneration();
      expect(posts).toBe(2);
      const currentControl = generateControl(),
        calls = vi.mocked(fetch).mock.calls.length;
      const late = reply(failed ? { error: "Retired fixture refusal" } : plan("retired"), failed ? 409 : 200);
      old.resolve(late);
      await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
      await new Promise((done) => setTimeout(done, 0));
      expect(currentControl.disabled).toBe(true);
      expect(node("#notice").textContent).toBe("Working…");
      expect(node("#connect").hidden).toBe(false);
      expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
      submitGeneration();
      expect(posts).toBe(2);
      data.plans = [generated, ...data.plans];
      fresh.resolve(reply(generated));
      await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
      expect(node("#plan-list article").getAttribute("data-plan-id")).toBe(generated.id);
      expect(posts).toBe(2);
      node<HTMLButtonElement>("#logout").click();
    }
  }
});

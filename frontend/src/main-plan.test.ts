import { afterEach, expect, it, vi } from "vitest";
import type { Plan, Snapshot } from "./generated";

const makePlan = (id: string): Plan => ({
  id,
  scope: "scope",
  scope_version: 1,
  inventory_revision: 1,
  network_revision: 1,
  request: {
    account_id: "account",
    vpc_id: `vpc-${id}`,
    subnet_ids: ["subnet"],
    network_id: "network",
    allow_application_traffic: false,
  },
  actions: [{ kind: "attachment", target: id, requires: [], postcondition: "reported available" }],
  digest: `immutable-${id}`,
});
const state = (role = "admin"): Snapshot => ({
  accounts: [],
  inventory: [],
  networks: [],
  plans: [makePlan("new"), makePlan("old")],
  operations: [],
  mode: "demo",
  role,
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function boot(snapshot: Snapshot, handler: (path: string) => Promise<Response>) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/plans");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      String(input) === "/api/v1/snapshot" ? Promise.resolve(response(snapshot)) : handler(String(input)),
    ),
  );
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  if (!token) throw new Error("Missing login");
  token.value = "fixture-admin";
  document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelectorAll("#plan-list article")).toHaveLength(1));
}
function select(id: string) {
  const input = document.querySelector<HTMLSelectElement>("#plan-selection");
  if (!input) throw new Error("Missing plan selection");
  input.value = id;
  input.dispatchEvent(new Event("change"));
}
const apply = () => {
  const node = document.querySelector<HTMLButtonElement>("#plan-list article button");
  if (!node) throw new Error("Missing selected-plan apply");
  return node;
};
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("binds local selection and execution to the exact immutable plan without changing payloads", async () => {
  const snapshot = state();
  const before = structuredClone(snapshot);
  const paths: string[] = [];
  const pending = deferred();
  await boot(snapshot, async (path) => {
    paths.push(path);
    return pending.promise;
  });
  const retired = apply();
  select("old");
  expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("old");
  expect(document.activeElement?.id).toBe("plan-selection");
  retired.click();
  expect(paths).toEqual([]);
  apply().click();
  expect(paths).toEqual(["/api/v1/plans/old/apply"]);
  const fetcher = vi.mocked(fetch);
  const init = fetcher.mock.calls.find(([url]) => url === "/api/v1/plans/old/apply")?.[1];
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ fault: "none" });
  expect(snapshot).toEqual(before);
  pending.resolve(response({ id: "operation" }));
  await vi.waitFor(() => expect(window.location.hash).toBe("#/operations"));
});

it("selection retires ignored-abort success and failure without unlocking a newer apply or navigating away", async () => {
  for (const failed of [false, true]) {
    const old = deferred(),
      fresh = deferred();
    await boot(state(), async (path) => (path.includes("/new/apply") ? old.promise : fresh.promise));
    const retired = apply();
    retired.click();
    expect(retired.disabled).toBe(true);
    select("old");
    const current = apply();
    current.click();
    old.resolve(response({ error: "retired apply" }, failed ? 409 : 200));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.hash).toBe("#/plans");
    expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("old");
    expect(current.disabled).toBe(true);
    expect(document.querySelector("#notice")?.textContent).toBe("Working…");
    fresh.resolve(response({ id: "new-operation" }));
    await vi.waitFor(() => expect(window.location.hash).toBe("#/operations"));
  }
});

it("retains read-only enforcement and invalidates plan controls on logout", async () => {
  const paths: string[] = [];
  await boot(state("read_only"), async (path) => {
    paths.push(path);
    return response({});
  });
  select("old");
  const button = apply();
  expect(button.disabled).toBe(true);
  button.click();
  expect(paths).toEqual([]);
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  button.dispatchEvent(new MouseEvent("click"));
  expect(paths).toEqual([]);
  expect(document.querySelectorAll("#plan-list article")).toHaveLength(0);
});

const appliedFixture = (id: string, planId: string): Snapshot["operations"][number] => ({
  id,
  plan_id: planId,
  scope: "scope",
  status: "queued",
  step: 0,
  attempts: 0,
  error: null,
  fault: "none",
});
it("snapshot replacement retires an old apply result without stealing a newer pending apply", async () => {
  for (const failed of [false, true]) {
    const data = state(),
      old = deferred(),
      fresh = deferred(),
      operation = appliedFixture("same-idempotent-operation", "new");
    let posts = 0;
    await boot(data, async () => (++posts === 1 ? old.promise : fresh.promise));
    const retired = apply();
    retired.click();
    document.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(apply()).not.toBe(retired));
    const current = apply();
    current.click();
    expect(posts).toBe(2);
    const calls = vi.mocked(fetch).mock.calls.length;
    const late = response(failed ? { error: "obsolete apply failure" } : operation, failed ? 409 : 200);
    old.resolve(late);
    await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
    await new Promise((done) => setTimeout(done, 0));
    expect(window.location.hash).toBe("#/plans");
    expect(current.isConnected).toBe(true);
    expect(current.disabled).toBe(true);
    expect(document.querySelector("#notice")?.textContent).toBe("Working…");
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    data.operations = [operation];
    fresh.resolve(response(operation));
    await vi.waitFor(() => expect(window.location.hash).toBe("#/operations"));
    expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe(
      operation.id,
    );
  }
});

it("a retired apply followup cannot leave an operation selection that resurfaces on refresh", async () => {
  const data = state(),
    oldOperation = appliedFixture("old-apply-operation", "new"),
    newest = appliedFixture("newer-history-operation", "old"),
    reload = deferred(),
    currentPost = deferred();
  await boot(data, async () => {
    throw new Error("Unexpected initial fixture request");
  });
  let reads = 0,
    posts = 0;
  vi.mocked(fetch).mockImplementation((input) => {
    const path = String(input);
    if (path === "/api/v1/snapshot") return ++reads === 1 ? reload.promise : Promise.resolve(response(data));
    if (path === "/api/v1/plans/new/apply") {
      posts++;
      return Promise.resolve(response(oldOperation));
    }
    if (path === "/api/v1/plans/old/apply") {
      posts++;
      return currentPost.promise;
    }
    throw new Error(`Unexpected apply fixture path ${path}`);
  });
  const retired = apply();
  retired.click();
  await vi.waitFor(() => expect(reads).toBe(1));
  select("old");
  data.operations = [newest, oldOperation];
  const late = response(data);
  reload.resolve(late);
  await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
  await new Promise((done) => setTimeout(done, 0));
  expect(window.location.hash).toBe("#/plans");
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() =>
    expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe(
      newest.id,
    ),
  );
  expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("old");
  apply().click();
  expect(posts).toBe(2);
  retired.disabled = false;
  retired.click();
  expect(posts).toBe(2);
  currentPost.resolve(response(newest));
  await vi.waitFor(() => expect(window.location.hash).toBe("#/operations"));
  expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe(
    newest.id,
  );
  const history = document.querySelector<HTMLSelectElement>("#operation-selection");
  if (!history) throw new Error("Missing operation history");
  history.value = oldOperation.id;
  history.dispatchEvent(new Event("change"));
  expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe(
    oldOperation.id,
  );
});

it("an intervening same-value refresh retires apply navigation during its followup snapshot", async () => {
  const data = state(),
    operation = appliedFixture("already-admitted-operation", "new"),
    reload = deferred();
  await boot(data, async () => {
    throw new Error("Unexpected initial fixture request");
  });
  let reads = 0;
  vi.mocked(fetch).mockImplementation((input) => {
    const path = String(input);
    if (path === "/api/v1/snapshot") return ++reads === 1 ? reload.promise : Promise.resolve(response(data));
    if (path === "/api/v1/plans/new/apply") return Promise.resolve(response(operation));
    throw new Error(`Unexpected fixture path ${path}`);
  });
  const retired = apply();
  retired.click();
  await vi.waitFor(() => expect(reads).toBe(1));
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(apply()).not.toBe(retired));
  expect(window.location.hash).toBe("#/plans");
  const late = response(data);
  reload.resolve(late);
  await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
  await new Promise((done) => setTimeout(done, 0));
  expect(window.location.hash).toBe("#/plans");
  expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("new");
  expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith("/apply"))).toHaveLength(1);
});

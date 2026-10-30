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

it("reader navigates from the selected original plan to its exact recorded operation without requests", async () => {
  const data = state("read_only");
  const older = appliedFixture("recorded-for-old", "old"),
    other = appliedFixture("default-for-new", "new");
  data.operations = [other, older];
  const before = structuredClone(data);
  await boot(data, async (path) => {
    throw new Error(`Unexpected recorded-operation navigation request ${path}`);
  });
  select("old");
  expect(apply().disabled).toBe(true);
  const calls = vi.mocked(fetch).mock.calls.length;
  const action = document.querySelector<HTMLButtonElement>("#plan-list [data-plan-operation]");
  expect(action).not.toBeNull();
  expect(action?.disabled).toBe(false);
  action?.click();
  await vi.waitFor(() => expect(window.location.hash).toBe("#/operations"));
  expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe(older.id);
  expect(
    JSON.parse(document.querySelector("#operation-list article details pre")?.textContent ?? "null"),
  ).toEqual(older);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  expect(data).toEqual(before);
  action?.dispatchEvent(new MouseEvent("click"));
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});

it("revalidates recorded-operation callback identities independently after mutation, refresh and logout", async () => {
  const data = state("read_only");
  data.operations = [appliedFixture("default", "new"), appliedFixture("recorded", "old")];
  await boot(data, async (path) => {
    throw new Error(`Unexpected callback request ${path}`);
  });
  select("old");
  const view = await import("./plan-review-view");
  const original = view.renderPlanReview;
  const capture: { args?: Parameters<typeof view.renderPlanReview> } = {};
  const spy = vi.spyOn(view, "renderPlanReview").mockImplementation((...args) => {
    capture.args = args;
    return original(...args);
  });
  try {
    document.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(capture.args).toBeDefined());
    const args = capture.args;
    if (!args) throw new Error("Missing plan context");
    const selected = args[0].find((p) => p.id === "old"),
      operations = args[1].operations,
      callback = args[1].onReviewOperation;
    const recorded = operations?.find((o) => o.id === "recorded");
    if (!selected || !recorded || !operations || !callback)
      throw new Error("Missing original callback context");
    const calls = vi.mocked(fetch).mock.calls.length;
    callback({ ...selected }, recorded);
    callback(selected, { ...recorded });
    const scope = recorded.scope;
    recorded.scope = "mismatched";
    callback(selected, recorded);
    recorded.scope = scope;
    args[0].push({ ...selected });
    callback(selected, recorded);
    args[0].pop();
    operations.push({ ...recorded, plan_id: "new" });
    callback(selected, recorded);
    operations.pop();
    operations.push({ ...recorded, id: undefined as unknown as string });
    callback(selected, recorded);
    operations.pop();
    expect(window.location.hash).toBe("#/plans");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
    document.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(capture.args).not.toBe(args));
    const afterRefresh = vi.mocked(fetch).mock.calls.length;
    callback(selected, recorded);
    expect(window.location.hash).toBe("#/plans");
    const current = capture.args;
    const currentPlan = current?.[0].find((p) => p.id === "old"),
      currentOperation = current?.[1].operations?.find((o) => o.id === "recorded");
    if (!current || !currentPlan || !currentOperation) throw new Error("Missing refreshed originals");
    document.querySelector<HTMLButtonElement>("#logout")?.click();
    current[1].onReviewOperation?.(currentPlan, currentOperation);
    expect(document.querySelectorAll("#operation-list article")).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(afterRefresh);
  } finally {
    spy.mockRestore();
  }
});

it("recorded-operation navigation retires an ignored-abort apply completion without another request", async () => {
  for (const failed of [false, true]) {
    const data = state(),
      recorded = appliedFixture("already-recorded", "old"),
      late = deferred();
    data.operations = [appliedFixture("different-default", "new"), recorded];
    const before = structuredClone(data);
    await boot(data, async (path) => {
      if (path === "/api/v1/plans/old/apply") return late.promise;
      throw new Error(`Unexpected retired apply path ${path}`);
    });
    select("old");
    const retiredApply = apply();
    retiredApply.click();
    expect(retiredApply.disabled).toBe(true);
    const action = document.querySelector<HTMLButtonElement>("#plan-list [data-plan-operation]");
    expect(action?.disabled).toBe(false);
    const calls = vi.mocked(fetch).mock.calls.length;
    action?.click();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/operations"));
    expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe(
      recorded.id,
    );
    const notice = document.querySelector("#notice")?.textContent;
    const reply = response(
      failed ? { error: "retired apply error" } : appliedFixture("late-result", "old"),
      failed ? 409 : 200,
    );
    late.resolve(reply);
    await vi.waitFor(() => expect(reply.bodyUsed).toBe(true));
    await new Promise((done) => setTimeout(done, 0));
    expect(window.location.hash).toBe("#/operations");
    expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe(
      recorded.id,
    );
    expect(document.querySelector("#notice")?.textContent).toBe(notice);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
    expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith("/apply"))).toHaveLength(1);
    expect(data).toEqual(before);
  }
});

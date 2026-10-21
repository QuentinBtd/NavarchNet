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

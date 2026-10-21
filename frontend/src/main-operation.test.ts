import { afterEach, expect, it, vi } from "vitest";
import type { Observation, Operation, Snapshot } from "./generated";

const operation = (id: string): Operation => ({
  id,
  plan_id: `plan-${id}`,
  scope: "scope",
  status: "succeeded",
  step: 1,
  attempts: 0,
  error: null,
  fault: "none",
});
const snapshot = (): Snapshot => ({
  accounts: [],
  inventory: [],
  networks: [],
  plans: [],
  operations: [operation("new"), operation("old")],
  mode: "demo",
  role: "admin",
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
const observation = (id: string, configuration: string): Observation => ({
  operation_id: id,
  configuration,
  calculated_path: "Simulated path",
  public_ips: [],
  connectivity: "Isolated",
  active_probe: "Not tested",
  drift: false,
  recovery: "Manual review",
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function boot(handler: (path: string) => Promise<Response>, state = snapshot()) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/operations");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      String(input) === "/api/v1/snapshot" ? Promise.resolve(response(state)) : handler(String(input)),
    ),
  );
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  if (!token) throw new Error("Missing login");
  token.value = "fixture-admin";
  document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector("#operation-list button")).not.toBeNull());
}
function inspect() {
  const node = Array.from(document.querySelectorAll<HTMLButtonElement>("#operation-list button")).find(
    (button) => button.textContent === "Inspect result & step events",
  );
  if (!node) throw new Error("Missing inspect action");
  return node;
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("snapshot replacement retires an ignored-abort operation observation while a newer inspect stays pending", async () => {
  const old = deferred(),
    fresh = deferred();
  let reads = 0;
  await boot(async (path) =>
    path.endsWith("/observation") ? (++reads === 1 ? old.promise : fresh.promise) : response([]),
  );
  const retired = inspect();
  retired.click();
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(inspect()).not.toBe(retired));
  const current = inspect();
  current.click();
  old.resolve(response(observation("new", "retired configuration")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector("#observation")?.textContent).toBe("");
  expect(document.querySelector("#notice")?.textContent).toBe("Working…");
  expect(current.disabled).toBe(true);
  fresh.resolve(response(observation("new", "current configuration")));
  await vi.waitFor(() =>
    expect(document.querySelector("#observation")?.textContent).toContain("current configuration"),
  );
  expect(current.disabled).toBe(false);
});

for (const status of [200, 409]) {
  it(`snapshot replacement retires pending event status ${status} without publishing half a result`, async () => {
    const old = deferred(),
      fresh = deferred();
    let observations = 0,
      events = 0;
    await boot(async (path) =>
      path.endsWith("/observation")
        ? response(observation("new", ++observations === 1 ? "retired" : "current"))
        : ++events === 1
          ? old.promise
          : fresh.promise,
    );
    const retired = inspect();
    retired.click();
    await vi.waitFor(() => expect(events).toBe(1));
    expect(document.querySelector("#observation")?.textContent).toBe("");
    document.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(inspect()).not.toBe(retired));
    const current = inspect();
    current.click();
    await vi.waitFor(() => expect(events).toBe(2));
    old.resolve(response([], status));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector("#observation")?.textContent).toBe("");
    expect(document.querySelector("#notice")?.textContent).toBe("Working…");
    expect(current.disabled).toBe(true);
    fresh.resolve(response([]));
    await vi.waitFor(() => expect(document.querySelector("#observation")?.textContent).toContain("current"));
  });
}

for (const transition of ["selection", "navigation", "logout"] as const) {
  for (const status of [200, 409]) {
    it(`${transition} retires ignored-abort observation status ${status} across a newer inspect`, async () => {
      const old = deferred(),
        fresh = deferred();
      let reads = 0;
      await boot(async (path) =>
        path.endsWith("/observation") ? (++reads === 1 ? old.promise : fresh.promise) : response([]),
      );
      inspect().click();
      const selected = transition === "selection" ? "old" : "new";
      if (transition === "selection") {
        const select = document.querySelector<HTMLSelectElement>("#operation-selection");
        if (!select) throw new Error("Missing selection");
        select.value = "old";
        select.dispatchEvent(new Event("change"));
        expect(document.activeElement?.id).toBe("operation-selection");
      } else if (transition === "navigation") {
        document.querySelector<HTMLAnchorElement>('nav a[href="#/networks"]')?.click();
        await vi.waitFor(() => expect(document.getElementById("networks")?.hidden).toBe(false));
        expect(window.location.hash).toBe("#/networks");
        document.querySelector<HTMLAnchorElement>('nav a[href="#/operations"]')?.click();
        await vi.waitFor(() => expect(document.getElementById("operations")?.hidden).toBe(false));
      } else {
        document.querySelector<HTMLButtonElement>("#logout")?.click();
        const token = document.querySelector<HTMLInputElement>("#token");
        if (!token) throw new Error("Missing login");
        token.value = "fixture-new-session";
        document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
        await vi.waitFor(() => expect(document.querySelector("#operation-list button")).not.toBeNull());
      }
      const current = inspect();
      current.click();
      old.resolve(response(observation("new", "retired configuration"), status));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector("#observation")?.textContent).toBe("");
      expect(document.querySelector("#notice")?.textContent).toBe("Working…");
      expect(current.disabled).toBe(true);
      fresh.resolve(response(observation(selected, "current configuration")));
      await vi.waitFor(() =>
        expect(document.querySelector("#observation")?.textContent).toContain("current configuration"),
      );
      expect(current.disabled).toBe(false);
    });
  }
}

it("keeps inspection readable after role downgrade but rejects disabled drift and duplicate actions", async () => {
  const state = snapshot();
  const pending = deferred();
  const paths: string[] = [];
  await boot(async (path) => {
    paths.push(path);
    return path.endsWith("/observation") ? pending.promise : response([]);
  }, state);
  const retired = inspect();
  state.role = "read_only";
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(inspect()).not.toBe(retired));
  const drift = Array.from(document.querySelectorAll<HTMLButtonElement>("#operation-list button")).find(
    (b) => b.textContent === "Simulate external drift",
  );
  expect(drift?.disabled).toBe(true);
  drift?.dispatchEvent(new MouseEvent("click"));
  const current = inspect();
  current.click();
  current.dispatchEvent(new MouseEvent("click"));
  expect(paths).toEqual(["/api/v1/operations/new/observation"]);
  pending.resolve(response(observation("new", "reader configuration")));
  await vi.waitFor(() =>
    expect(document.querySelector("#observation")?.textContent).toContain("reader configuration"),
  );
  expect(drift?.disabled).toBe(true);
});

for (const label of ["Inspect result & step events", "Simulate external drift"]) {
  it(`${label} refuses mismatched operation evidence and permits retry`, async () => {
    await boot(async (path) =>
      path.endsWith("/observation") ? response(observation("wrong", "wrong evidence")) : response([]),
    );
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("#operation-list button")).find(
      (b) => b.textContent === label,
    );
    if (!button) throw new Error("Missing operation action");
    button.click();
    await vi.waitFor(() =>
      expect(document.querySelector("#notice")?.textContent).toContain("did not match selected operation"),
    );
    expect(document.querySelector("#observation")?.textContent).toBe("");
    expect(document.querySelector("#operation-events")?.textContent).toBe("");
    expect(button.disabled).toBe(false);
  });
}

it("never exposes the demo drift control outside demo authentication mode", async () => {
  const state = snapshot();
  state.mode = "oidc";
  await boot(async () => response([]), state);
  expect(document.querySelector("#operation-list")?.textContent).not.toContain("Simulate external drift");
});

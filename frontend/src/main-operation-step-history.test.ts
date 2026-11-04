import { afterEach, expect, it, vi } from "vitest";
import type { Observation, Snapshot } from "./generated";

const state = (): Snapshot => ({
  accounts: [],
  inventory: [],
  networks: [],
  plans: [],
  operations: [
    {
      id: "operation",
      plan_id: "original-plan",
      scope: "scope",
      status: "partial",
      step: 2,
      attempts: 1,
      error: "Reported failure",
      fault: "none",
    },
  ],
  mode: "demo",
  role: "read_only",
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
const observation = (): Observation => ({
  operation_id: "operation",
  configuration: "Simulated partial configuration",
  calculated_path: "Simulated path",
  public_ips: [],
  connectivity: "Unknown",
  active_probe: "Not tested",
  drift: false,
  recovery: "Manual review",
});
const rows = (prefix = "reported") =>
  Array.from({ length: 45 }, (_, index) => ({
    step: index % 3,
    fence: index + 1,
    outcome: index === 2 ? "<img src=x onerror=alert(1)>" : `${prefix}-${index}`,
    at: `reported-time-${index}`,
  }));
const response = (value: unknown) => new Response(JSON.stringify(value));
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}
function inspect() {
  const control = [...document.querySelectorAll<HTMLButtonElement>("#operation-list button")].find(
    (b) => b.textContent === "Inspect result & step events",
  );
  if (!control) throw new Error("Missing inspect");
  return control;
}
const history = () => document.querySelector<HTMLElement>('[aria-label="Recorded step history"]');
async function boot(events: () => Promise<Response>) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/operations");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1/snapshot") return response(state());
      if (path.endsWith("/observation")) return response(observation());
      if (path.endsWith("/events")) return events();
      throw new Error(`Unexpected step history request ${path}`);
    }),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-reader";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector("#operation-list article")).not.toBeNull());
  await vi.waitFor(() => expect(node("#operations").hidden).toBe(false));
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("shows complete returned step events in bounded original order with exact raw JSON and no pagination queries", async () => {
  const events = rows(),
    before = structuredClone(events);
  await boot(async () => response(events));
  const calls = vi.mocked(fetch).mock.calls.length;
  inspect().click();
  await vi.waitFor(() =>
    expect(document.querySelector("#operation-events")?.textContent).toBe(JSON.stringify(events, null, 2)),
  );
  expect(history()).not.toBeNull();
  expect(history()?.dataset.operationId).toBe("operation");
  expect(history()?.querySelectorAll("li")).toHaveLength(20);
  expect(history()?.textContent).toContain("Showing 20 of 45 returned events");
  expect(history()?.textContent).toContain("not connectivity measurements");
  expect(history()?.querySelector("img")).toBeNull();
  const more = history()?.querySelector<HTMLButtonElement>("button");
  if (!more) throw new Error("Missing continuation");
  more.click();
  more.click();
  const items = [...(history()?.querySelectorAll<HTMLLIElement>("li") ?? [])];
  expect(items).toHaveLength(events.length);
  for (const [index, item] of items.entries()) {
    expect(item.value).toBe(index + 1);
    expect(item.dataset.eventIndex).toBe(String(index));
    expect(item.dataset.stepIndex).toBe(String(events[index].step));
    expect(item.textContent).toContain(`Step ${events[index].step + 1}`);
    expect(item.textContent).toContain(`Fence ${events[index].fence}`);
    expect(item.textContent).toContain(events[index].outcome);
    expect(item.textContent).toContain(events[index].at);
  }
  expect(more.disabled).toBe(true);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls + 2);
  expect(events).toEqual(before);
});

it("clears step history on a new inspection, refresh, navigation and logout and rejects retired pagination or late events", async () => {
  const late = deferred();
  let reads = 0;
  await boot(async () => (++reads === 2 ? late.promise : response(rows(reads === 1 ? "initial" : "fresh"))));
  inspect().click();
  await vi.waitFor(() =>
    expect(document.querySelector("#operation-events")?.textContent).toContain("initial-0"),
  );
  expect(history()).not.toBeNull();
  const retiredMore = history()?.querySelector<HTMLButtonElement>("button");
  if (!retiredMore) throw new Error("Missing old continuation");
  await vi.waitFor(() => expect(inspect().disabled).toBe(false));
  const oldInspect = inspect();
  oldInspect.click();
  expect(node("#operation-step-history").textContent).toBe("");
  retiredMore.click();
  expect(history()).toBeNull();
  await vi.waitFor(() => expect(reads).toBe(2));
  node("#refresh").click();
  await vi.waitFor(() => expect(inspect()).not.toBe(oldInspect));
  inspect().click();
  await vi.waitFor(() => expect(history()?.textContent).toContain("fresh-0"));
  const freshMore = history()?.querySelector<HTMLButtonElement>("button");
  if (!freshMore) throw new Error("Missing fresh continuation");
  late.resolve(response(rows("retired")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(history()?.textContent).toContain("fresh-0");
  expect(history()?.textContent).not.toContain("retired-0");
  node<HTMLAnchorElement>('nav a[href="#/overview"]').click();
  await vi.waitFor(() => expect(node("#overview").hidden).toBe(false));
  freshMore.click();
  expect(node("#operation-step-history").textContent).toBe("");
  node("#logout").click();
  retiredMore.click();
  freshMore.click();
  expect(history()).toBeNull();
});

it("atomically validates and snapshots complete callback rows and fences retained continuation controls", async () => {
  // GREEN-only renderer qualification, not malformed native JSON or an extra production RED.
  const { renderOperationStepHistory } = await import("./operation-step-history");
  const bad: unknown[] = [null, {}, Array(1001).fill(rows()[0])];
  const sparse = rows();
  delete sparse[44];
  bad.push(sparse);
  const inherited = rows();
  delete inherited[44];
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 44: rows()[44] }));
  bad.push(inherited);
  for (const value of [-1, Number.MAX_SAFE_INTEGER, 1.5]) {
    const data = rows();
    data[44].step = value;
    bad.push(data);
  }
  for (const [key, value] of [
    ["fence", -1],
    ["fence", Infinity],
    ["outcome", null],
    ["at", 42],
  ] as const) {
    const data = rows() as unknown as Record<string, unknown>[];
    data[44][key] = value;
    bad.push(data);
  }
  const missing = rows() as unknown as Record<string, unknown>[];
  delete missing[44].at;
  bad.push(missing);
  const inheritedFields = rows();
  inheritedFields[44] = Object.create(rows()[44]);
  bad.push(inheritedFields);
  for (const data of bad) {
    const root = renderOperationStepHistory(data, "operation", () => true);
    expect(root.textContent).toContain("history unavailable");
    expect(root.querySelectorAll("li,button")).toHaveLength(0);
  }
  const empty = renderOperationStepHistory([], "operation", () => true);
  expect(empty.textContent).toContain("does not establish that no execution occurred");
  expect(empty.querySelector("button")).toBeNull();
  const data = rows();
  data[0].outcome = "";
  data[0].at = "";
  data[4] = { ...data[3] };
  let current = true;
  const root = renderOperationStepHistory(data, "operation", () => current);
  document.body.append(root);
  expect(root.textContent).toContain('"" (empty string)');
  const more = root.querySelector<HTMLButtonElement>("button");
  if (!more) throw new Error("Missing callback continuation");
  const callback = more.onclick as () => void;
  more.disabled = true;
  callback();
  more.disabled = false;
  current = false;
  callback();
  expect(root.querySelectorAll("li")).toHaveLength(20);
  current = true;
  data[21].outcome = "edited-after-capture";
  more.click();
  expect(root.querySelectorAll("li")).toHaveLength(40);
  expect(root.textContent).toContain("reported-21");
  expect(root.textContent).not.toContain("edited-after-capture");
  const duplicate = [...root.querySelectorAll("li")].slice(3, 5);
  expect(duplicate[0].textContent).toBe(duplicate[1].textContent);
  more.remove();
  callback();
  expect(root.querySelectorAll("li")).toHaveLength(40);
  root.append(more);
  root.remove();
  callback();
  expect(root.querySelectorAll("li")).toHaveLength(40);
});

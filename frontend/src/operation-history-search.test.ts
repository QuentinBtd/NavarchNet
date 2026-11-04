import { afterEach, expect, it, vi } from "vitest";
import type { Observation, Operation, Snapshot } from "./generated";
import { operationHistorySearch } from "./operation-history-search";
import { renderOperationReview } from "./operation-review-view";

const operation = (id: string, status = "succeeded"): Operation => ({
  id,
  plan_id: `plan-${id}`,
  scope: "account/vpc",
  status,
  step: 2,
  attempts: 1,
  error: null,
  fault: "none",
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("searches returned operation literals without selecting another detail or inspecting it", () => {
  const operations = [operation("newer"), operation("older", "partial")];
  const before = structuredClone(operations),
    onSelect = vi.fn(),
    makeInspect = vi.fn(() => document.createElement("button"));
  const root = renderOperationReview(operations, [], {
    selectedOperationId: "newer",
    isCurrent: () => true,
    onSelect,
    makeInspect,
  });
  document.body.append(root);
  const search = root.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search).not.toBeNull();
  if (!search) throw new Error("Missing local operation history search");
  search.value = "partial";
  search.dispatchEvent(new Event("input"));
  expect([...root.querySelectorAll<HTMLOptionElement>("select option")].map((o) => o.value)).toEqual([
    "older",
  ]);
  expect(root.querySelector("article")?.dataset.operationId).toBe("newer");
  expect(root.textContent).toContain(
    "Selected operation is outside search results; its detail is unchanged.",
  );
  expect(root.textContent).toContain("1 of 2 returned operations match");
  expect(onSelect).not.toHaveBeenCalled();
  expect(makeInspect).toHaveBeenCalledTimes(1);
  expect(JSON.parse(root.querySelector("article pre")?.textContent ?? "null")).toEqual(operations[0]);
  const select = root.querySelector<HTMLSelectElement>("select");
  if (!select) throw new Error("Missing operation selection");
  expect(select.value).toBe("");
  select.value = "older";
  select.dispatchEvent(new Event("change"));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("older");
  expect(operations).toEqual(before);
});

it("preserves literal order and refuses incomplete, excess or changed search captures and retired controls", () => {
  const mount = (operations: Operation[]) => {
    const root = document.createElement("div"),
      select = document.createElement("select"),
      state = { query: "" };
    // The helper validates its entire search capture; do not invoke the legacy detail renderer on deliberately malformed rows.
    for (let i = 0; i < operations.length; i++) {
      const option = document.createElement("option");
      option.value = operations[i]?.id ?? String(i);
      select.append(option);
    }
    root.append(select);
    let current = true;
    const search = operationHistorySearch(root, select, operations, operations[0]?.id, () => current, state);
    root.prepend(search.controls);
    document.body.append(root);
    const input = root.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error("Missing search");
    const query = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    return {
      root,
      select,
      state,
      input,
      query,
      search,
      retire: () => {
        current = false;
      },
    };
  };
  const literalOperation = operation(" +%é <script> ", "UnknownState");
  literalOperation.plan_id = "Plan EXACT";
  literalOperation.error = "not-a-search-field";
  const values = [literalOperation, operation("next", "partial")];
  const first = mount(values);
  for (const term of [
    " +%é ",
    "Plan EXACT",
    "account/vpc",
    "UnknownState",
    "",
    "not-a-search-field",
    "plan exact",
  ]) {
    first.query(term);
    const expected = values.filter((row) =>
      [row.id, row.plan_id, row.scope, row.status].some((value) => value.includes(term)),
    );
    expect(first.select.options.length).toBe(expected.length);
    for (const row of values) expect(first.search.canSelect(row.id)).toBe(expected.includes(row));
    expect(first.state.query).toBe(term);
  }
  expect(first.root.querySelector("script")).toBeNull();
  first.query("x".repeat(257));
  expect(first.select.options).toHaveLength(0);
  expect(first.select.disabled).toBe(true);
  expect(first.root.textContent).toContain("Operation search unavailable");
  first.query("");
  expect(first.select.options).toHaveLength(2);
  first.input.disabled = true;
  first.query("partial");
  expect(first.state.query).toBe("");
  first.input.disabled = false;
  first.root.append(first.input);
  first.query("partial");
  expect(first.state.query).toBe("");
  first.search.controls.append(first.input);
  first.select.remove();
  first.query("partial");
  expect(first.state.query).toBe("");
  first.root.append(first.select);
  first.retire();
  first.query("partial");
  expect(first.state.query).toBe("");
  const many = mount(Array.from({ length: 1000 }, (_, i) => operation(`op-${i}`)));
  many.query("op-999");
  expect(many.select.options).toHaveLength(1);
  expect(many.select.options[0]?.value).toBe("op-999");
  expect(many.search.canSelect("op-999")).toBe(true);
  many.query("x".repeat(256));
  expect(many.root.textContent).toContain("0 of 1000 returned operations match");
  const sparse = [operation("prefix"), operation("tail")];
  delete sparse[1];
  const inherited = [operation("prefix"), operation("tail")];
  delete inherited[1];
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 1: operation("tail") }));
  const inheritedField = operation("tail");
  delete (inheritedField as Partial<Operation>).scope;
  Object.setPrototypeOf(inheritedField, { scope: "inherited" });
  for (const rows of [
    sparse,
    inherited,
    [operation("prefix"), inheritedField],
    [operation("duplicate"), operation("duplicate")],
    [operation("prefix"), { ...operation("tail"), status: "x".repeat(16385) }],
    Array.from({ length: 1001 }, (_, i) => operation(String(i))),
    Array.from({ length: 33 }, (_, i) => ({
      ...operation(String(i)),
      scope: "x".repeat(16384),
      status: "y".repeat(16384),
    })),
  ]) {
    const rejected = mount(rows);
    expect(rejected.select.options).toHaveLength(0);
    expect(rejected.select.disabled).toBe(true);
    expect(rejected.root.textContent).toContain("Operation search unavailable");
    expect(rejected.search.canSelect(rows[0]?.id ?? "")).toBe(false);
  }
  for (const change of [
    (rows: Operation[]) => {
      const row = rows[1];
      if (!row) throw new Error("Missing tail fixture");
      rows[1] = { ...row };
    },
    (rows: Operation[]) => {
      const row = rows[1];
      if (!row) throw new Error("Missing tail fixture");
      row.status = "changed";
    },
    (rows: Operation[]) => {
      rows.push(operation("prefix"));
    },
  ]) {
    const rows = [operation("prefix"), operation("tail")],
      changed = mount(rows);
    change(rows);
    expect(changed.search.canSelect("prefix")).toBe(false);
    changed.query("prefix");
    expect(changed.select.options).toHaveLength(0);
  }
  const detached = mount([operation("a")]);
  detached.root.remove();
  detached.query("a");
  expect(detached.state.query).toBe("");
  const renderedRows = [operation("a"), operation("b")],
    onSelect = vi.fn();
  const rendered = renderOperationReview(renderedRows, [], {
    isCurrent: () => true,
    onSelect,
    makeInspect: () => document.createElement("button"),
  });
  document.body.append(rendered);
  const picker = rendered.querySelector<HTMLSelectElement>("select"),
    input = rendered.querySelector<HTMLInputElement>("input");
  if (!picker || !input) throw new Error("Missing controls");
  input.value = "no-match";
  input.dispatchEvent(new Event("input"));
  picker.disabled = false;
  const forged = document.createElement("option");
  forged.value = "a";
  picker.append(forged);
  picker.value = "a";
  picker.dispatchEvent(new Event("change"));
  expect(onSelect).not.toHaveBeenCalled();
});

it("keeps search and selected evidence independent across parent selection, pending reads, refresh, navigation and logout", async () => {
  vi.resetModules();
  const snapshot: Snapshot = {
    accounts: [],
    inventory: [],
    networks: [],
    plans: [],
    operations: [operation("newer"), operation("older", "partial")],
    mode: "demo",
    role: "read_only",
    aws_accounts: [],
    aws_regions: [],
    aws_read_only_enabled: false,
  };
  let resolveObservation: ((response: Response) => void) | undefined;
  const events = [{ step: 1, fence: 2, outcome: "persisted", at: "opaque-time" }];
  const observed: Observation = {
    operation_id: "older",
    configuration: "Persisted simulation",
    calculated_path: "Unknown",
    public_ips: [],
    connectivity: "Not measured",
    active_probe: "Not tested",
    drift: false,
    recovery: "Manual review",
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/snapshot") return new Response(JSON.stringify(snapshot));
    if (path === "/api/v1/operations/older/observation")
      return new Promise<Response>((resolve) => {
        resolveObservation = resolve;
      });
    if (path === "/api/v1/operations/older/events") return new Response(JSON.stringify(events));
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/operations");
  await import("./main");
  const login = async () => {
    const token = document.querySelector<HTMLInputElement>("#token");
    if (!token) throw new Error("Missing login");
    token.value = "fixture-reader";
    document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector("#operations")?.hasAttribute("hidden")).toBe(false));
  };
  const search = () => {
    const input = document.querySelector<HTMLInputElement>("#operation-history-search");
    if (!input) throw new Error("Missing search");
    return input;
  };
  const query = (value: string) => {
    search().value = value;
    search().dispatchEvent(new Event("input"));
  };
  const button = (label: string) => {
    const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (!node) throw new Error(`Missing button ${label}`);
    return node;
  };
  await login();
  const initialCalls = fetcher.mock.calls.length;
  query("partial");
  const picker = document.querySelector<HTMLSelectElement>("#operation-selection");
  if (!picker) throw new Error("Missing selection");
  expect(picker.value).toBe("");
  expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe("newer");
  picker.value = "older";
  picker.dispatchEvent(new Event("change"));
  expect(search().value).toBe("partial");
  expect(fetcher.mock.calls.length).toBe(initialCalls);
  const retainedInput = search();
  button("Inspect result & step events").click();
  await vi.waitFor(() => expect(resolveObservation).toBeDefined());
  const pendingCalls = fetcher.mock.calls.length;
  query("no-match");
  expect(button("Inspect result & step events").disabled).toBe(true);
  expect(fetcher.mock.calls.length).toBe(pendingCalls);
  resolveObservation?.(new Response(JSON.stringify(observed)));
  await vi.waitFor(() =>
    expect(document.querySelector("#operation-events")?.textContent).toBe(JSON.stringify(events, null, 2)),
  );
  const exported = document.querySelector("#operation-export")?.firstElementChild;
  const pairedCalls = fetcher.mock.calls.length;
  query("partial");
  query("not-found");
  query("");
  expect(document.querySelector("#operation-export")?.firstElementChild).toBe(exported);
  expect(fetcher.mock.calls.length).toBe(pairedCalls);
  query("partial");
  const older = snapshot.operations[1];
  if (!older) throw new Error("Missing older fixture");
  older.status = "running";
  button("Refresh").click();
  await vi.waitFor(() => expect(search()).not.toBe(retainedInput));
  expect(search().value).toBe("partial");
  expect(document.querySelectorAll("#operation-selection option")).toHaveLength(0);
  expect(document.querySelector("#operation-list article")?.getAttribute("data-operation-id")).toBe("older");
  expect(document.querySelector("#operation-export")?.children).toHaveLength(0);
  retainedInput.value = "stale";
  retainedInput.dispatchEvent(new Event("input"));
  expect(search().value).toBe("partial");
  const currentInput = search();
  window.location.hash = "#/overview";
  await vi.waitFor(() => expect(document.querySelector("#operations")?.hasAttribute("hidden")).toBe(true));
  currentInput.value = "stale-away";
  currentInput.dispatchEvent(new Event("input"));
  window.location.hash = "#/operations";
  await vi.waitFor(() => expect(document.querySelector("#operations")?.hasAttribute("hidden")).toBe(false));
  // A refresh rebuilds from the admitted memory query, not the retired off-view input value.
  button("Refresh").click();
  await vi.waitFor(() => expect(search()).not.toBe(currentInput));
  expect(search().value).toBe("partial");
  button("Sign out").click();
  retainedInput.value = "stale-logout";
  retainedInput.dispatchEvent(new Event("input"));
  await login();
  expect(search().value).toBe("");
  expect(document.querySelectorAll("#operation-selection option")).toHaveLength(2);
  expect(
    fetcher.mock.calls.every(
      ([input]) => !String(input).includes("partial") && !String(input).includes("not-found"),
    ),
  ).toBe(true);
});

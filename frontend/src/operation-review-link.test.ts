import { afterEach, expect, it, vi } from "vitest";
import type { Observation, Operation, Snapshot } from "./generated";
import { operationReviewHref, readOperationReviewIntent } from "./operation-review-link";
import { renderOperationReview } from "./operation-review-view";

function operation(id: string): Operation {
  return {
    id,
    plan_id: "plan-not-in-link",
    scope: "scope-not-in-link",
    status: "partial",
    step: 2,
    attempts: 1,
    error: "manual review, not in link",
    fault: "partial_failure",
  };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("links the exact nonfirst returned operation without encoding persisted state or inspecting automatically", () => {
  const operations = [
    operation("11111111-1111-4111-8111-111111111111"),
    operation("22222222-2222-4222-8222-222222222222"),
  ];
  const original = operations[1];
  if (!original) throw new Error("Missing original operation");
  const before = structuredClone(operations),
    fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const root = renderOperationReview(operations, [], {
    selectedOperationId: original.id,
    isCurrent: () => true,
    onSelect: vi.fn(),
    makeInspect: () => {
      const inspect = document.createElement("button");
      inspect.textContent = "Inspect original";
      return inspect;
    },
  });
  document.body.append(root);
  const link = root.querySelector<HTMLAnchorElement>("[data-operation-review-link]");
  expect(link).not.toBeNull();
  expect(link?.textContent).toBe("Link to this returned operation");
  expect(link?.getAttribute("href")).toBe(`#/operations?operation=${encodeURIComponent(original.id)}`);
  expect(link?.getAttribute("href")).not.toContain(original.plan_id);
  expect(link?.getAttribute("href")).not.toContain(original.scope);
  if (!link) throw new Error("Missing original link");
  const event = new MouseEvent("click", { cancelable: true });
  let accepted = false;
  link.addEventListener(
    "click",
    (click) => {
      accepted = !click.defaultPrevented;
      click.preventDefault();
    },
    { once: true },
  );
  link.dispatchEvent(event);
  expect(accepted).toBe(true);
  expect(root.querySelector("button")?.textContent).toBe("Inspect original");
  expect(JSON.parse(root.querySelector("details pre")?.textContent ?? "null")).toEqual(original);
  expect(operations).toEqual(before);
  expect(fetcher).not.toHaveBeenCalled();
});

it("retains literal codec limits and refuses stale or changed operation-link evidence", () => {
  for (const id of ["a+b", " a ", "%&?=#/<>", "é", "𐀀", "x".repeat(2048), "é".repeat(1024)]) {
    const hash = operationReviewHref(id);
    expect(readOperationReviewIntent(hash ?? "")).toEqual({ kind: "operation", id, hash });
  }
  expect(readOperationReviewIntent("#/operations?operation=a+b")).toEqual({
    kind: "operation",
    id: "a+b",
    hash: "#/operations?operation=a%2Bb",
  });
  for (const id of [
    null,
    undefined,
    {},
    1,
    "",
    "a\n",
    "\u0085",
    "\ud800",
    "\udfff",
    "x".repeat(2049),
    "é".repeat(1025),
  ])
    expect(operationReviewHref(id)).toBeUndefined();
  for (const hash of [
    "#/operations?operation",
    "#/operations?operation=",
    "#/operations?operation=%",
    "#/operations?operation=%ZZ",
    "#/operations?operation=%C0%AF",
    "#/operations?operation=%ED%A0%80",
    "#/operations?operation=%00",
    "#/operations?operation=a&operation=b",
    "#/operations?operation=a&plan=b",
    "#/operations?operation=a&token=not-used",
    "#/operations?operation=" + "x".repeat(8193),
  ])
    expect(readOperationReviewIntent(hash)).toEqual({ kind: "invalid", hash: "#/operations?operation=" });
  for (const hash of ["#/plans?plan=x", "#/operations", "#/operations?plan=x", "#/accounts"])
    expect(readOperationReviewIntent(hash)).toEqual({ kind: "none" });
  const original = operation("original"),
    operations = [original];
  let live = true;
  const root = renderOperationReview(operations, [], {
    isCurrent: () => live,
    onSelect: vi.fn(),
    makeInspect: () => document.createElement("button"),
  });
  document.body.append(root);
  const link = root.querySelector<HTMLAnchorElement>("[data-operation-review-link]"),
    card = link?.parentElement;
  if (!link || !card) throw new Error("Missing original link");
  const refused = () => {
    const event = new MouseEvent("click", { cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  live = false;
  refused();
  live = true;
  link.setAttribute("aria-disabled", "true");
  refused();
  link.removeAttribute("aria-disabled");
  const href = link.getAttribute("href");
  if (!href) throw new Error("Missing href");
  link.setAttribute("href", "#/accounts");
  refused();
  link.setAttribute("href", href);
  link.remove();
  refused();
  card.append(link);
  root.remove();
  refused();
  document.body.append(root);
  root.append(link);
  refused();
  card.append(link);
  operations[0] = { ...original };
  refused();
  operations[0] = original;
  operations.push({ ...original });
  refused();
  operations.pop();
  for (const field of ["id", "plan_id", "scope", "status", "step", "attempts", "error", "fault"] as const) {
    const value = original[field];
    Reflect.set(original, field, field === "step" || field === "attempts" ? 9 : "changed");
    refused();
    Reflect.set(original, field, value);
  }
  Reflect.set(original, "cycle", original);
  refused();
  Reflect.deleteProperty(original, "cycle");
  const event = new MouseEvent("click", { cancelable: true });
  let accepted = false;
  link.addEventListener(
    "click",
    (click) => {
      accepted = !click.defaultPrevented;
      click.preventDefault();
    },
    { once: true },
  );
  link.dispatchEvent(event);
  expect(accepted).toBe(true);
});

it("the real parent binds operation source, restores current state, and retires ignored-abort evidence across URI history", async () => {
  vi.resetModules();
  const first = "first",
    second = "second";
  const state: Snapshot = {
    accounts: [],
    inventory: [],
    networks: [],
    plans: [],
    operations: [operation(first), operation(second)],
    mode: "demo",
    role: "read_only",
    aws_accounts: [],
    aws_regions: [],
    aws_read_only_enabled: false,
  };
  const response = (value: unknown) => new Response(JSON.stringify(value));
  const deferred = () => {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const observations: ReturnType<typeof deferred>[] = [],
    events: ReturnType<typeof deferred>[] = [],
    paths: string[] = [];
  const observed = (id: string, configuration: string): Observation => ({
    operation_id: id,
    configuration,
    calculated_path: "Simulated",
    public_ips: [],
    connectivity: "Isolated",
    active_probe: "Not tested",
    drift: false,
    recovery: "Manual review",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      // Expose a typed client snapshot for provenance mutation, not malformed HTTP evidence.
      if (path === "/api/v1/snapshot")
        return Promise.resolve(Object.assign(response(state), { json: async () => state }));
      if (path.endsWith("/observation")) {
        const pending = deferred();
        observations.push(pending);
        return pending.promise;
      }
      if (path.endsWith("/events")) {
        const pending = deferred();
        events.push(pending);
        return pending.promise;
      }
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", `#/operations?operation=${second}`);
  await import("./main");
  const login = () => {
    const token = document.querySelector<HTMLInputElement>("#token");
    if (!token) throw new Error("Missing login");
    token.value = "fixture-reader";
    document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  };
  const selected = () => document.querySelector<HTMLElement>("#operation-list article")?.dataset.operationId;
  const inspect = () => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("#operation-list button")).find(
      (node) => node.textContent === "Inspect result & step events",
    );
    if (!button) throw new Error("Missing Inspect");
    return button;
  };
  login();
  await vi.waitFor(() => expect(selected()).toBe(second));
  expect(paths).toEqual(["/api/v1/snapshot"]);
  const originalOperations = state.operations;
  state.operations = originalOperations.map((row) => ({ ...row }));
  const retained = document.querySelector<HTMLAnchorElement>("[data-operation-review-link]");
  if (!retained) throw new Error("Missing parent link");
  const refused = new MouseEvent("click", { cancelable: true });
  retained.dispatchEvent(refused);
  expect(refused.defaultPrevented).toBe(true);
  state.operations = originalOperations;
  window.location.hash = `#/operations?operation=${first}`;
  await vi.waitFor(() => expect(selected()).toBe(first));
  inspect().click();
  await vi.waitFor(() => expect(observations).toHaveLength(1));
  window.location.hash = `#/operations?operation=${second}`;
  await vi.waitFor(() => expect(selected()).toBe(second));
  const newer = inspect();
  newer.click();
  await vi.waitFor(() => expect(observations).toHaveLength(2));
  observations[0]?.resolve(response(observed(first, "Retired observation")));
  await new Promise((done) => setTimeout(done, 0));
  expect(events).toHaveLength(0);
  expect(newer.disabled).toBe(true);
  expect(document.querySelector("#observation")?.textContent).toBe("");
  observations[1]?.resolve(response(observed(second, "Retired after events")));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(document.querySelector("#observation")?.textContent).toBe("");
  window.history.back();
  await vi.waitFor(() => expect(selected()).toBe(first));
  const current = inspect();
  current.click();
  await vi.waitFor(() => expect(observations).toHaveLength(3));
  events[0]?.resolve(response([]));
  await new Promise((done) => setTimeout(done, 0));
  expect(current.disabled).toBe(true);
  expect(document.querySelector("#observation")?.textContent).toBe("");
  observations[2]?.resolve(response(observed(first, "Current explicit inspection")));
  await vi.waitFor(() => expect(events).toHaveLength(2));
  events[1]?.resolve(response([]));
  await vi.waitFor(() => expect(current.disabled).toBe(false));
  expect(document.querySelector("#observation")?.textContent).toContain("Current explicit inspection");
  expect(paths.filter((path) => path === `/api/v1/operations/${first}/events`)).toHaveLength(1);
  window.history.forward();
  await vi.waitFor(() => expect(selected()).toBe(second));
  expect(document.querySelector("#observation")?.textContent).toBe("");
  window.history.back();
  await vi.waitFor(() => expect(selected()).toBe(first));
  const picker = document.querySelector<HTMLSelectElement>("#operation-selection");
  if (!picker) throw new Error("Missing picker");
  picker.value = second;
  picker.dispatchEvent(new Event("change"));
  expect(selected()).toBe(second);
  expect(window.location.hash).toBe("#/operations");
  const record = state.operations[1];
  if (!record) throw new Error("Missing current operation");
  record.step = 4;
  record.attempts = 0;
  record.status = "succeeded";
  record.error = null;
  const oldCard = document.querySelector("#operation-list article");
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(document.querySelector("#operation-list article")).not.toBe(oldCard));
  expect(selected()).toBe(second);
  expect(JSON.parse(document.querySelector("#operation-list details pre")?.textContent ?? "null")).toEqual(
    record,
  );
  window.location.hash = "#/operations?operation=absent";
  await vi.waitFor(() => expect(selected()).toBeUndefined());
  window.location.hash = "#/operations?operation=%ZZ";
  await vi.waitFor(() => expect(window.location.hash).toBe("#/operations?operation="));
  expect(selected()).toBeUndefined();
  state.operations.push({ ...record });
  window.location.hash = `#/operations?operation=${second}`;
  await vi.waitFor(() =>
    expect(document.querySelector("#operation-list")?.textContent).toContain(
      "Selected operation unavailable or ambiguous",
    ),
  );
  expect(selected()).toBeUndefined();
  state.operations.pop();
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  login();
  await vi.waitFor(() => expect(selected()).toBe(second));
  expect(JSON.parse(document.querySelector("#operation-list details pre")?.textContent ?? "null")).toEqual(
    record,
  );
});

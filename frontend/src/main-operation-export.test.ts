import { afterEach, expect, it, vi } from "vitest";
import type { Observation, Operation, Snapshot } from "./generated";
import { renderOperationInspectionExport } from "./operation-inspection-export";

const operation = (id: string): Operation => ({
  id,
  plan_id: `plan-${id}`,
  scope: "scope",
  status: "partial",
  step: 2,
  attempts: 1,
  error: "Manual review",
  fault: "partial_failure",
});
const state = (): Snapshot => ({
  accounts: [],
  inventory: [],
  networks: [],
  plans: [],
  operations: [operation("newer"), operation("older")],
  mode: "demo",
  role: "read_only",
  aws_accounts: [],
  aws_regions: [],
  aws_read_only_enabled: false,
});
const observed = (id: string): Observation => ({
  operation_id: id,
  configuration: "Persisted simulation",
  calculated_path: "Reported simulated path",
  public_ips: [],
  connectivity: "Not measured",
  active_probe: "Not tested",
  drift: false,
  recovery: "Manual review",
});
const events = [{ step: 1, fence: 2, outcome: "reported <literal>", at: "opaque-time" }];
const provenance = {
  operation_snapshot: "Authenticated returned snapshot",
  observation: "Explicit operation-scoped GET",
  events: "Explicit operation-scoped GET; row identity inherited from request",
  atomic_capture: false,
  connectivity: "No measurement inferred by this export",
};
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  );
}
function contents(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("downloads only the complete selected explicit inspection without another read or mutation", async () => {
  vi.resetModules();
  const snapshot = state(),
    create = vi.fn((_blob: Blob) => "blob:inspection"),
    revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }),
  );
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.isConnected).toBe(true);
    expect(this.download).toBe("navarchnet-operation-inspection.json");
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/snapshot") return new Response(JSON.stringify(snapshot));
    if (path === "/api/v1/operations/older/observation")
      return new Response(JSON.stringify(observed("older")));
    if (path === "/api/v1/operations/older/events") return new Response(JSON.stringify(events));
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/operations");
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  if (!token) throw new Error("Missing login");
  token.value = "fixture-reader";
  document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelectorAll("#operation-selection option")).toHaveLength(2));
  const picker = document.querySelector<HTMLSelectElement>("#operation-selection");
  if (!picker) throw new Error("Missing operation selection");
  picker.value = "older";
  picker.dispatchEvent(new Event("change"));
  expect(button("Download captured inspection JSON")).toBeUndefined();
  button("Inspect result & step events")?.click();
  await vi.waitFor(() =>
    expect(document.querySelector("#operation-events")?.textContent).toBe(JSON.stringify(events, null, 2)),
  );
  const download = button("Download captured inspection JSON");
  expect(download).toBeDefined();
  if (!download) throw new Error("Missing inspection export");
  const calls = fetcher.mock.calls.length;
  download.click();
  expect(create).toHaveBeenCalledTimes(1);
  expect(clicked).toHaveBeenCalledTimes(1);
  const blob = create.mock.calls[0]?.[0];
  if (!blob) throw new Error("Missing captured JSON Blob");
  expect(JSON.parse(await contents(blob))).toEqual({
    format: "navarchnet.operation-inspection.v1",
    operation_snapshot: snapshot.operations[1],
    observation: observed("older"),
    events,
    provenance,
  });
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(document.querySelector("a[download]")).toBeNull();
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:inspection"));
});

it("refuses malformed, oversized, changed and retired captures without allocating a partial download", () => {
  const create = vi.fn((_blob: Blob) => "blob:capture"),
    revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const record = operation("literal-<record>"),
    observation = observed(record.id),
    rows: unknown[] = [
      { step: 0, fence: 1, outcome: "", at: "" },
      { step: 0, fence: 1, outcome: "", at: "" },
    ];
  let current = true;
  const root = renderOperationInspectionExport(record, observation, rows, () => current);
  document.body.append(root);
  const download = root.querySelector("button");
  if (!download) throw new Error("Missing valid captured export");
  const refused = () => {
    download.dispatchEvent(new MouseEvent("click"));
    expect(create).not.toHaveBeenCalled();
  };
  download.disabled = true;
  refused();
  download.disabled = false;
  current = false;
  refused();
  current = true;
  download.remove();
  refused();
  root.append(download);
  const foreign = document.createElement("div");
  document.body.append(foreign);
  foreign.append(download);
  refused();
  root.append(download);
  root.remove();
  refused();
  document.body.append(root);
  record.error = "changed";
  refused();
  record.error = "Manual review";
  observation.operation_id = "other";
  refused();
  observation.operation_id = record.id;
  observation.configuration = "changed";
  refused();
  observation.configuration = "Persisted simulation";
  rows.push({ extra: "changed" });
  refused();
  rows.pop();
  rows.push(rows);
  refused();
  rows.pop();
  const malformed = [
    renderOperationInspectionExport(operation(""), observed(""), [], () => true),
    renderOperationInspectionExport(record, observed("other"), [], () => true),
    renderOperationInspectionExport(record, observation, undefined, () => true),
    renderOperationInspectionExport(
      record,
      { ...observation, configuration: "x".repeat(4 * 1024 * 1024) },
      [],
      () => true,
    ),
  ];
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  malformed.push(renderOperationInspectionExport(record, observation, cyclic, () => true));
  for (const unavailable of malformed) {
    expect(unavailable.querySelector("button")).toBeNull();
    expect(unavailable.textContent).toContain("unavailable");
  }
  expect(create).not.toHaveBeenCalled();
  download.click();
  expect(create).toHaveBeenCalledTimes(1);
  expect(root.querySelector("a[download]")).toBeNull();
});

it("the real parent publishes no partial or retired export and binds the exact unique source and original mount", async () => {
  vi.resetModules();
  const source = state(),
    create = vi.fn((_blob: Blob) => "blob:current");
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const response = (value: unknown) => new Response(JSON.stringify(value));
  const deferred = () => {
    let resolve!: (value: Response) => void, reject!: (error: Error) => void;
    const promise = new Promise<Response>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const observations: ReturnType<typeof deferred>[] = [],
    replies: ReturnType<typeof deferred>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      // Typed parent source mutation, not malformed native HTTP evidence.
      if (path === "/api/v1/snapshot")
        return Promise.resolve(Object.assign(response(source), { json: async () => source }));
      if (path.endsWith("/observation")) {
        const pending = deferred();
        observations.push(pending);
        return pending.promise;
      }
      if (path.endsWith("/events")) {
        const pending = deferred();
        replies.push(pending);
        return pending.promise;
      }
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/operations");
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  if (!token) throw new Error("Missing login");
  token.value = "fixture-reader";
  document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector("#operation-selection")).not.toBeNull());
  const inspect = () => {
    const control = button("Inspect result & step events");
    if (!control) throw new Error("Missing Inspect");
    control.click();
  };
  inspect();
  expect(button("Download captured inspection JSON")).toBeUndefined();
  observations[0]?.resolve(response(observed("newer")));
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  expect(button("Download captured inspection JSON")).toBeUndefined();
  replies[0]?.reject(new Error("events unavailable"));
  await vi.waitFor(() => expect(button("Inspect result & step events")?.disabled).toBe(false));
  expect(button("Download captured inspection JSON")).toBeUndefined();
  inspect();
  await vi.waitFor(() => expect(observations).toHaveLength(2));
  const picker = document.querySelector<HTMLSelectElement>("#operation-selection");
  if (!picker) throw new Error("Missing picker");
  picker.value = "older";
  picker.dispatchEvent(new Event("change"));
  inspect();
  await vi.waitFor(() => expect(observations).toHaveLength(3));
  observations[1]?.resolve(response(observed("newer")));
  await new Promise((done) => setTimeout(done, 0));
  expect(replies).toHaveLength(1);
  expect(button("Download captured inspection JSON")).toBeUndefined();
  expect(button("Inspect result & step events")?.disabled).toBe(true);
  observations[2]?.resolve(response(observed("older")));
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  expect(button("Download captured inspection JSON")).toBeUndefined();
  replies[1]?.resolve(response(events));
  await vi.waitFor(() => expect(button("Download captured inspection JSON")).toBeDefined());
  const download = button("Download captured inspection JSON"),
    record = source.operations[1];
  if (!download || !record) throw new Error("Missing current capture");
  source.operations.push({ ...record });
  download.dispatchEvent(new MouseEvent("click"));
  expect(create).not.toHaveBeenCalled();
  source.operations.pop();
  const mount = document.querySelector("#operation-export"),
    root = download.parentElement;
  if (!mount || !root) throw new Error("Missing captured mount");
  document.body.append(root);
  download.click();
  expect(create).not.toHaveBeenCalled();
  mount.append(root);
  const originalRows = source.operations;
  source.operations = originalRows.map((row) => ({ ...row }));
  download.click();
  expect(create).not.toHaveBeenCalled();
  source.operations = originalRows;
  const oldCard = document.querySelector("#operation-list article");
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(document.querySelector("#operation-list article")).not.toBe(oldCard));
  expect(button("Download captured inspection JSON")).toBeUndefined();
  download.click();
  expect(create).not.toHaveBeenCalled();
  inspect();
  await vi.waitFor(() => expect(observations).toHaveLength(4));
  observations[3]?.resolve(response(observed("older")));
  await vi.waitFor(() => expect(replies).toHaveLength(3));
  window.location.hash = "#/overview";
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#operations")?.hidden).toBe(true));
  replies[2]?.resolve(response(events));
  await new Promise((done) => setTimeout(done, 0));
  expect(button("Download captured inspection JSON")).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
  window.location.hash = "#/operations";
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#operations")?.hidden).toBe(false));
  inspect();
  await vi.waitFor(() => expect(observations).toHaveLength(5));
  observations[4]?.resolve(response(observed("older")));
  await vi.waitFor(() => expect(replies).toHaveLength(4));
  replies[3]?.resolve(response(events));
  await vi.waitFor(() => expect(button("Download captured inspection JSON")).toBeDefined());
  const last = button("Download captured inspection JSON");
  if (!last) throw new Error("Missing fresh capture");
  last.click();
  expect(create).toHaveBeenCalledTimes(1);
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  last.click();
  expect(create).toHaveBeenCalledTimes(1);
  expect(button("Download captured inspection JSON")).toBeUndefined();
});

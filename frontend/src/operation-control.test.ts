import { afterEach, expect, it, vi } from "vitest";
import type { Observation, Operation, Plan, Snapshot } from "./generated";

const plan = (id: string): Plan => ({
  id: `plan-${id}`,
  scope: `scope-${id}`,
  scope_version: 0,
  inventory_revision: 1,
  network_revision: 1,
  request: {
    account_id: "app",
    vpc_id: "vpc",
    network_id: "network",
    subnet_ids: ["subnet"],
    allow_application_traffic: false,
  },
  actions: [{ kind: "attachment", target: "vpc", requires: [], postcondition: "Simulated attachment" }],
  digest: id,
});
const operation = (id: string): Operation => ({
  id,
  plan_id: `plan-${id}`,
  scope: `scope-${id}`,
  status: "succeeded",
  step: 1,
  attempts: 0,
  error: null,
  fault: "none",
});
const observed = (configuration: string): Observation => ({
  operation_id: "original",
  configuration,
  calculated_path: "Simulated path",
  public_ips: [],
  connectivity: "Not measured",
  active_probe: "Not tested",
  drift: false,
  recovery: "Manual review",
});
const state = (): Snapshot => ({
  accounts: [],
  inventory: [],
  networks: [],
  plans: [plan("default"), plan("original")],
  operations: [operation("default"), operation("original")],
  mode: "demo",
  role: "admin",
  aws_accounts: [],
  aws_regions: [],
  aws_read_only_enabled: false,
});
const reply = (value: unknown) => new Response(JSON.stringify(value));
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
function action(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("#operation-list button")].find(
    (b) => b.textContent === label,
  );
  if (!found) throw new Error(`Missing operation action ${label}`);
  return found;
}
const inspect = () => action("Inspect result & step events");
const drift = () => action("Simulate external drift");
async function boot(handler: (path: string, init?: RequestInit) => Promise<Response>) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/operations");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-admin";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelectorAll("#operation-selection option")).toHaveLength(2));
  node<HTMLSelectElement>("#operation-selection").value = "original";
  node("#operation-selection").dispatchEvent(new Event("change"));
  expect(node("#operation-list article").getAttribute("data-operation-id")).toBe("original");
}
const tick = () => new Promise((done) => setTimeout(done, 0));
function contents(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}
afterEach(() => {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("admits original-operation reads and drift only from their mounted review while preserving paired evidence and explicit download", async () => {
  for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
    document.querySelector<HTMLButtonElement>("#logout")?.click();
    const data = state(),
      before = structuredClone(data),
      observation = deferred(),
      events = deferred();
    const initial = observed("Initial captured configuration"),
      fresh = observed("Fresh captured configuration");
    const oldRows = [{ step: 0, fence: 1, outcome: "initial", at: "old-time" }];
    const freshRows = [{ step: 0, fence: 2, outcome: "reported <literal>", at: "opaque-time" }];
    const calls: { path: string; method: string; body?: string }[] = [];
    let reads = 0,
      eventReads = 0;
    const create = vi.fn((_blob: Blob) => "blob:original-inspection"),
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
    await boot(async (path, init) => {
      if (path === "/api/v1/snapshot") return reply(data);
      calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
      if (path === "/api/v1/operations/original/observation")
        return ++reads === 1
          ? reply(initial)
          : reads === 2
            ? observation.promise
            : reply({ ...fresh, drift: true });
      if (path === "/api/v1/operations/original/events")
        return ++eventReads === 1 ? reply(oldRows) : events.promise;
      if (path === "/api/v1/operations/original/demo-drift") return new Response(null, { status: 204 });
      throw new Error(`Unexpected original-operation request ${path}`);
    });
    const originalInspect = inspect(),
      originalDrift = drift(),
      card = node("#operation-list article"),
      review = card.parentElement,
      mount = node("#operation-list");
    if (!review) throw new Error("Missing original operation review");
    try {
      originalInspect.click();
      await vi.waitFor(() =>
        expect(node("#operation-events").textContent).toBe(JSON.stringify(oldRows, null, 2)),
      );
      await vi.waitFor(() => expect(originalInspect.disabled || originalDrift.disabled).toBe(false));
      expect(node("#observation").textContent).toContain(initial.configuration);
      expect(node("#operation-export [data-operation-export]")).toBeDefined();
      const evidence = [
        "#observation",
        "#operation-step-history",
        "#operation-events",
        "#operation-export",
      ].map((s) => node(s).innerHTML);
      const notice = node("#notice").textContent;
      const beforeCalls = structuredClone(calls);
      expect(beforeCalls).toEqual([
        { path: "/api/v1/operations/original/observation", method: "GET" },
        { path: "/api/v1/operations/original/events", method: "GET" },
      ]);
      for (const control of [originalInspect, originalDrift]) {
        const next = control.nextSibling;
        expect(control.isConnected && review.contains(control) && mount.contains(review)).toBe(true);
        expect(control.disabled).toBe(false);
        if (displacement === "removed-control") control.remove();
        else if (displacement === "moved-control") node("#diagnostics").append(control);
        else if (displacement === "removed-review") review.remove();
        else node("#diagnostics").append(review);
        control.dispatchEvent(new MouseEvent("click"));
        expect(calls, `${displacement} ${control.textContent}`).toEqual(beforeCalls);
        expect(
          ["#observation", "#operation-step-history", "#operation-events", "#operation-export"].map(
            (s) => node(s).innerHTML,
          ),
        ).toEqual(evidence);
        expect(node("#notice").textContent).toBe(notice);
        expect(data).toEqual(before);
        await tick();
        expect(calls).toEqual(beforeCalls);
        if (displacement.endsWith("control")) card.insertBefore(control, next);
        else mount.append(review);
      }
      originalInspect.click();
      expect(originalInspect.disabled && originalDrift.disabled).toBe(true);
      originalInspect.dispatchEvent(new MouseEvent("click"));
      originalDrift.dispatchEvent(new MouseEvent("click"));
      expect(calls).toHaveLength(3);
      expect(node("#observation").children).toHaveLength(0);
      expect(node("#operation-export").children).toHaveLength(0);
      observation.resolve(reply(fresh));
      await vi.waitFor(() => expect(eventReads).toBe(2));
      expect(node("#observation").children).toHaveLength(0);
      expect(node("#operation-export").children).toHaveLength(0);
      events.resolve(reply(freshRows));
      await vi.waitFor(() =>
        expect(node("#operation-events").textContent).toBe(JSON.stringify(freshRows, null, 2)),
      );
      await vi.waitFor(() => expect(originalInspect.disabled || originalDrift.disabled).toBe(false));
      expect(node("#observation").textContent).toContain(fresh.configuration);
      expect(node("#operation-step-history").textContent).toContain("reported <literal>");
      const download = node<HTMLButtonElement>("#operation-export [data-operation-export]");
      const finalCalls = structuredClone(calls);
      download.click();
      expect(create).toHaveBeenCalledTimes(1);
      expect(clicked).toHaveBeenCalledTimes(1);
      const blob = create.mock.calls[0]?.[0];
      if (!blob) throw new Error("Missing complete inspection Blob");
      expect(JSON.parse(await contents(blob))).toEqual({
        format: "navarchnet.operation-inspection.v1",
        operation_snapshot: before.operations[1],
        observation: fresh,
        events: freshRows,
        provenance: {
          operation_snapshot: "Authenticated returned snapshot",
          observation: "Explicit operation-scoped GET",
          events: "Explicit operation-scoped GET; row identity inherited from request",
          atomic_capture: false,
          connectivity: "No measurement inferred by this export",
        },
      });
      expect(calls).toEqual(finalCalls);
      expect(node("#operation-export").querySelector("a[download]")).toBeNull();
      await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:original-inspection"));
      originalDrift.click();
      await vi.waitFor(() =>
        expect(node("#observation").textContent).toContain("Detected — no automatic repair"),
      );
      expect(calls.slice(-2)).toEqual([
        { path: "/api/v1/operations/original/demo-drift", method: "POST", body: "{}" },
        { path: "/api/v1/operations/original/observation", method: "GET" },
      ]);
      expect(node("#operation-export").children).toHaveLength(0);
      expect(data).toEqual(before);
      node<HTMLButtonElement>("#refresh").click();
      await vi.waitFor(() => expect(inspect()).not.toBe(originalInspect));
      expect(node("#operation-list article").getAttribute("data-operation-id")).toBe("original");
      expect(node("#operation-export").children).toHaveLength(0);
      const afterRefreshCalls = structuredClone(calls);
      originalInspect.disabled = false;
      originalInspect.dispatchEvent(new MouseEvent("click"));
      originalDrift.disabled = false;
      originalDrift.dispatchEvent(new MouseEvent("click"));
      expect(calls).toEqual(afterRefreshCalls);
      expect(data).toEqual(before);
    } finally {
      node<HTMLButtonElement>("#logout").click();
      observation.resolve(reply(fresh));
      events.resolve(reply(freshRows));
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  }
});

it("retires removed original-operation controls at each real Main await seam without publishing, unlocking or automatically recovering evidence", async () => {
  for (const phase of ["observation", "events", "drift-post", "drift-observation"]) {
    for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
      for (const outcome of phase === "events" && displacement === "moved-review"
        ? ["success", "failure"]
        : ["success"]) {
        document.querySelector<HTMLButtonElement>("#logout")?.click();
        const data = state(),
          before = structuredClone(data),
          pending = deferred();
        const value = observed("Explicitly recovered configuration"),
          rows = [{ step: 0, fence: 2, outcome: "recovered", at: "time" }];
        const calls: string[] = [];
        let hold = true;
        await boot(async (path, init) => {
          if (path === "/api/v1/snapshot") return reply(data);
          calls.push(`${init?.method ?? "GET"} ${path}`);
          if (path === "/api/v1/operations/original/observation")
            return hold && ["observation", "drift-observation"].includes(phase)
              ? pending.promise
              : reply(value);
          if (path === "/api/v1/operations/original/events")
            return hold && phase === "events" ? pending.promise : reply(rows);
          if (path === "/api/v1/operations/original/demo-drift")
            return hold && phase === "drift-post" ? pending.promise : new Response(null, { status: 204 });
          throw new Error(`Unexpected retired operation request ${path}`);
        });
        const originalInspect = inspect(),
          originalDrift = drift(),
          control = phase.startsWith("drift") ? originalDrift : originalInspect;
        const review = node("#operation-list article").parentElement;
        if (!review) throw new Error("Missing original operation review");
        try {
          control.click();
          await vi.waitFor(() =>
            expect(calls).toHaveLength(["events", "drift-observation"].includes(phase) ? 2 : 1),
          );
          expect(originalInspect.disabled && originalDrift.disabled).toBe(true);
          for (const selector of [
            "#observation",
            "#operation-step-history",
            "#operation-events",
            "#operation-export",
          ])
            expect(node(selector).textContent).toBe("");
          const working = node("#notice").textContent,
            beforeCalls = [...calls];
          if (displacement === "removed-control") control.remove();
          else if (displacement === "moved-control") node("#diagnostics").append(control);
          else if (displacement === "removed-review") review.remove();
          else node("#diagnostics").append(review);
          hold = false;
          pending.resolve(
            outcome === "failure"
              ? new Response("Late read unavailable", { status: 503 })
              : phase === "events"
                ? reply(rows)
                : phase === "drift-post"
                  ? new Response(null, { status: 204 })
                  : reply(value),
          );
          await tick();
          await tick();
          expect(calls, `${phase}/${displacement}/${outcome}`).toEqual(beforeCalls);
          for (const selector of [
            "#observation",
            "#operation-step-history",
            "#operation-events",
            "#operation-export",
          ])
            expect(node(selector).textContent).toBe("");
          expect(node("#notice").textContent).toBe(working);
          expect(originalInspect.disabled && originalDrift.disabled).toBe(true);
          expect(data).toEqual(before);
          // Controlled detached DOM is not cancellation, restoration or automatic recovery.
          review.remove();
          control.remove();
          node<HTMLButtonElement>("#refresh").click();
          await vi.waitFor(() => expect(inspect()).not.toBe(originalInspect));
          expect(inspect().disabled || drift().disabled).toBe(false);
          expect(node("#operation-list article").dataset.operationId).toBe("original");
          expect(calls).toEqual(beforeCalls);
          expect(node("#operation-export").children).toHaveLength(0);
          originalInspect.disabled = false;
          originalDrift.disabled = false;
          originalInspect.dispatchEvent(new MouseEvent("click"));
          originalDrift.dispatchEvent(new MouseEvent("click"));
          expect(calls).toEqual(beforeCalls);
          inspect().click();
          await vi.waitFor(() =>
            expect(node("#operation-events").textContent).toBe(JSON.stringify(rows, null, 2)),
          );
          expect(node("#observation").textContent).toContain(value.configuration);
          expect(calls.slice(beforeCalls.length)).toEqual([
            "GET /api/v1/operations/original/observation",
            "GET /api/v1/operations/original/events",
          ]);
          expect(data).toEqual(before);
        } finally {
          node<HTMLButtonElement>("#logout").click();
          pending.resolve(reply(value));
        }
      }
    }
  }
}, 15_000);

it("keeps captured local-download ownership bound to its original mounted operation context without adding requests or changing read-only policy", async () => {
  for (const role of ["admin", "readonly"]) {
    for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
      document.querySelector<HTMLButtonElement>("#logout")?.click();
      const data = { ...state(), role },
        before = structuredClone(data),
        value = observed("Captured original configuration"),
        rows = [{ step: 0, fence: 1, outcome: "captured", at: "time" }];
      const calls: string[] = [],
        create = vi.fn((_blob: Blob) => "blob:captured-original");
      vi.stubGlobal(
        "URL",
        Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }),
      );
      const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      await boot(async (path, init) => {
        if (path === "/api/v1/snapshot") return reply(data);
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/api/v1/operations/original/observation") return reply(value);
        if (path === "/api/v1/operations/original/events") return reply(rows);
        throw new Error(`Unexpected captured-inspection request ${path}`);
      });
      try {
        const control = inspect(),
          card = node("#operation-list article"),
          review = card.parentElement;
        if (!review) throw new Error("Missing captured original review");
        expect(control.disabled).toBe(false);
        expect(drift().disabled).toBe(role !== "admin");
        control.click();
        await vi.waitFor(() =>
          expect(node("#operation-events").textContent).toBe(JSON.stringify(rows, null, 2)),
        );
        await vi.waitFor(() => expect(control.disabled).toBe(false));
        const download = node<HTMLButtonElement>("#operation-export [data-operation-export]"),
          beforeCalls = [...calls],
          next = control.nextSibling;
        if (displacement === "removed-control") control.remove();
        else if (displacement === "moved-control") node("#diagnostics").append(control);
        else if (displacement === "removed-review") review.remove();
        else node("#diagnostics").append(review);
        expect(download.isConnected).toBe(true);
        download.dispatchEvent(new MouseEvent("click"));
        expect(create).not.toHaveBeenCalled();
        expect(clicked).not.toHaveBeenCalled();
        expect(calls).toEqual(beforeCalls);
        expect(data).toEqual(before);
        if (displacement.endsWith("control")) card.insertBefore(control, next);
        else node("#operation-list").append(review);
        download.click();
        expect(create).toHaveBeenCalledTimes(1);
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(calls).toEqual(beforeCalls);
        const blob = create.mock.calls[0]?.[0];
        if (!blob) throw new Error("Missing original local capture Blob");
        const captured = JSON.parse(await contents(blob));
        expect(captured.operation_snapshot).toEqual(before.operations[1]);
        expect(captured.observation).toEqual(value);
        expect(captured.events).toEqual(rows);
        await tick();
        node<HTMLButtonElement>("#refresh").click();
        await vi.waitFor(() => expect(inspect()).not.toBe(control));
        expect(drift().disabled).toBe(role !== "admin");
        download.dispatchEvent(new MouseEvent("click"));
        expect(create).toHaveBeenCalledTimes(1);
        expect(calls).toEqual(beforeCalls);
        expect(data).toEqual(before);
      } finally {
        node<HTMLButtonElement>("#logout").click();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    }
  }
});

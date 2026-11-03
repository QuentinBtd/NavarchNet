import { afterEach, expect, it, vi } from "vitest";
import type { Observation, Operation, Plan, Snapshot } from "./generated";

const plan = (id: string): Plan => ({
  id: `plan-${id}`,
  scope: `scope-${id}`,
  scope_version: 1,
  inventory_revision: 1,
  network_revision: 1,
  request: {
    account_id: "app",
    vpc_id: `vpc-${id}`,
    network_id: "network",
    subnet_ids: ["subnet"],
    allow_application_traffic: false,
  },
  actions: [{ kind: "attachment", target: `vpc-${id}`, requires: [], postcondition: "Simulated attachment" }],
  digest: `original-${id}`,
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
const state = (role = "admin"): Snapshot => ({
  accounts: [],
  inventory: [],
  networks: [],
  plans: [plan("default"), plan("original")],
  operations: [operation("default"), operation("original")],
  mode: "demo",
  role,
  aws_accounts: [],
  aws_read_only_enabled: false,
  aws_regions: [],
});
const observed: Observation = {
  operation_id: "original",
  configuration: "Captured original configuration",
  calculated_path: "Simulated path",
  public_ips: [],
  connectivity: "Not measured",
  active_probe: "Not tested",
  drift: false,
  recovery: "Manual review",
};
const rows = [{ step: 0, fence: 2, outcome: "reported <literal>", at: "opaque-time" }];
const reply = (value: unknown) => new Response(JSON.stringify(value));
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
function button(mount: string, label: string) {
  const control = [...node(mount).querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label,
  );
  if (!control) throw new Error(`Missing ${mount} ${label}`);
  return control;
}
async function boot(
  data: Snapshot,
  workspace: string,
  handler: (path: string, init?: RequestInit) => Promise<Response>,
) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", `#/${workspace}`);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/v1/snapshot" ? Promise.resolve(reply(data)) : handler(String(input), init),
    ),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-credential-free";
  node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
  const kind = workspace === "plans" ? "plan" : "operation";
  await vi.waitFor(() => expect(node(`#${workspace}`).hidden).toBe(false));
  await vi.waitFor(() => expect(node<HTMLSelectElement>(`#${kind}-selection`).options).toHaveLength(2));
  node<HTMLSelectElement>(`#${kind}-selection`).value = workspace === "plans" ? "plan-original" : "original";
  node(`#${kind}-selection`).dispatchEvent(new Event("change"));
}
async function contents(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}
const tick = () => new Promise((done) => setTimeout(done, 0));
afterEach(() => {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("keeps original-history local review navigation inside its own mounted frame and restores only explicit exact-record navigation", async () => {
  for (const workspace of ["operations", "plans"]) {
    for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
      document.querySelector<HTMLButtonElement>("#logout")?.click();
      const data = state(),
        before = structuredClone(data),
        calls: string[] = [];
      const create = vi.fn((_blob: Blob) => "blob:original-plan"),
        revoke = vi.fn();
      vi.stubGlobal(
        "URL",
        Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }),
      );
      const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        expect(this.isConnected).toBe(true);
        expect(this.download).toBe("navarchnet-plan.json");
      });
      await boot(data, workspace, async (path, init) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/api/v1/operations/original/observation") return reply(observed);
        if (path === "/api/v1/operations/original/events") return reply(rows);
        throw new Error(`Unexpected local-history request ${path}`);
      });
      try {
        const mount = node(workspace === "plans" ? "#plan-list" : "#operation-list"),
          card = mount.querySelector<HTMLElement>("article"),
          review = card?.parentElement;
        if (!card || !review) throw new Error("Missing original history frame");
        expect(card.dataset[workspace === "plans" ? "planId" : "operationId"]).toBe(
          workspace === "plans" ? "plan-original" : "original",
        );
        if (workspace === "operations") {
          button("#operation-list", "Inspect result & step events").click();
          await vi.waitFor(() =>
            expect(node("#operation-events").textContent).toBe(JSON.stringify(rows, null, 2)),
          );
          await vi.waitFor(() =>
            expect(button("#operation-list", "Inspect result & step events").disabled).toBe(false),
          );
        }
        const control = button(
            workspace === "plans" ? "#plan-list" : "#operation-list",
            workspace === "plans" ? "Review recorded operation" : "Review original plan",
          ),
          next = control.nextSibling;
        const evidence = [
            "#observation",
            "#operation-events",
            "#operation-step-history",
            "#operation-export",
          ].map((s) => node(s).innerHTML),
          notice = node("#notice").textContent,
          beforeCalls = [...calls];
        expect(control.disabled).toBe(false);
        if (displacement === "removed-control") control.remove();
        else if (displacement === "moved-control") node("#diagnostics").append(control);
        else if (displacement === "removed-review") review.remove();
        else node("#diagnostics").append(review);
        control.dispatchEvent(new MouseEvent("click"));
        expect(window.location.hash, `${displacement} ${workspace}`).toBe(`#/${workspace}`);
        expect(node(`#${workspace}`).hidden).toBe(false);
        expect(calls).toEqual(beforeCalls);
        expect(
          ["#observation", "#operation-events", "#operation-step-history", "#operation-export"].map(
            (s) => node(s).innerHTML,
          ),
        ).toEqual(evidence);
        expect(node("#notice").textContent).toBe(notice);
        expect(data).toEqual(before);
        await tick();
        expect(window.location.hash).toBe(`#/${workspace}`);
        if (displacement.endsWith("control")) card.insertBefore(control, next);
        else mount.append(review);
        control.click();
        const target = workspace === "plans" ? "operations" : "plans";
        await vi.waitFor(() => expect(node(`#${target}`).hidden).toBe(false));
        expect(node("#operation-list article").dataset.operationId).toBe("original");
        expect(node("#plan-list article").dataset.planId).toBe("plan-original");
        expect(JSON.parse(node("#operation-list article details pre").textContent ?? "null")).toEqual(
          before.operations[1],
        );
        expect(JSON.parse(node("#plan-list article details pre").textContent ?? "null")).toEqual(
          before.plans[1],
        );
        expect(calls).toEqual(beforeCalls);
        button(
          target === "plans" ? "#plan-list" : "#operation-list",
          target === "plans" ? "Review recorded operation" : "Review original plan",
        ).click();
        await vi.waitFor(() => expect(node(`#${workspace}`).hidden).toBe(false));
        // The original operation can be inspected again only explicitly, never by local navigation.
        expect(calls).toEqual(beforeCalls);
        if (workspace === "operations") {
          button("#operation-list", "Review original plan").click();
          await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
        }
        const download = button("#plan-list", "Download original plan JSON");
        download.dispatchEvent(new MouseEvent("click"));
        expect(create).toHaveBeenCalledTimes(1);
        expect(clicked).toHaveBeenCalledTimes(1);
        const blob = create.mock.calls[0]?.[0];
        if (!blob) throw new Error("Missing original Plan Blob");
        expect(JSON.parse(await contents(blob))).toEqual(before.plans[1]);
        await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:original-plan"));
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

function linkCanceled(link: HTMLAnchorElement) {
  let canceled = false;
  link.addEventListener(
    "click",
    (event) => {
      canceled = event.defaultPrevented;
      event.preventDefault();
    },
    { once: true },
  );
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return canceled;
}

it("keeps local evidence, returned-record links and history choices scoped to the original mounted history without changing read permissions", async () => {
  for (const role of ["admin", "read_only"]) {
    for (const workspace of ["plans", "operations"]) {
      document.querySelector<HTMLButtonElement>("#logout")?.click();
      const data = state(role),
        original = data.plans[1];
      if (!original) throw new Error("Missing original Plan");
      original.actions.push({
        kind: "isolation",
        target: "original-policy",
        requires: [0],
        postcondition: "Requested isolation",
      });
      const before = structuredClone(data),
        calls: string[] = [],
        create = vi.fn((_blob: Blob) => "blob:local-evidence");
      vi.stubGlobal(
        "URL",
        Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }),
      );
      const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      await boot(data, workspace, async (path, init) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        throw new Error(`Unexpected local request ${path}`);
      });
      try {
        const kind = workspace === "plans" ? "plan" : "operation",
          mount = node(`#${kind}-list`),
          card = mount.querySelector<HTMLElement>("article"),
          review = card?.parentElement;
        if (!card || !review) throw new Error("Missing local evidence frame");
        const link = node<HTMLAnchorElement>(`#${kind}-list [data-${kind}-review-link]`),
          select = node<HTMLSelectElement>(`#${kind}-selection`),
          search = node<HTMLInputElement>(`#${kind}-history-search`);
        const download =
          workspace === "plans" ? button("#plan-list", "Download original plan JSON") : undefined;
        const detail =
          workspace === "plans" ? node('#plan-list [aria-label="Requested action detail"]') : undefined;
        const next = workspace === "plans" ? button("#plan-list", "Next proposed action") : undefined;
        if (detail) expect(detail.dataset.actionIndex).toBe("0");
        if (next) expect(next.disabled).toBe(false);
        expect(linkCanceled(link)).toBe(false);
        node("#diagnostics").append(review);
        expect(review.isConnected && review.contains(link) && !mount.contains(review)).toBe(true);
        expect(linkCanceled(link)).toBe(true);
        download?.click();
        next?.click();
        expect(create).not.toHaveBeenCalled();
        expect(clicked).not.toHaveBeenCalled();
        if (detail) expect(detail.dataset.actionIndex).toBe("0");
        select.value = workspace === "plans" ? "plan-default" : "default";
        select.dispatchEvent(new Event("change"));
        search.value = "default";
        search.dispatchEvent(new Event("input"));
        expect(window.location.hash).toBe(`#/${workspace}`);
        expect(card.dataset[`${kind}Id`]).toBe(workspace === "plans" ? "plan-original" : "original");
        expect(calls).toEqual([]);
        expect(data).toEqual(before);
        mount.append(review);
        expect(linkCanceled(link)).toBe(false);
        if (download && next && detail) {
          download.click();
          expect(create).toHaveBeenCalledTimes(1);
          const blob = create.mock.calls[0]?.[0];
          if (!blob) throw new Error("Missing original evidence Blob");
          expect(JSON.parse(await contents(blob))).toEqual(before.plans[1]);
          next.click();
          expect(detail.dataset.actionIndex).toBe("1");
          expect(detail.textContent).toContain("original-policy");
          await tick();
        }
        node<HTMLButtonElement>("#refresh").click();
        await vi.waitFor(() => expect(node(`#${kind}-selection`)).not.toBe(select));
        expect(node<HTMLInputElement>(`#${kind}-history-search`).value).toBe("");
        expect(node(`#${kind}-list article`).dataset[`${kind}Id`]).toBe(
          workspace === "plans" ? "plan-original" : "original",
        );
        expect(linkCanceled(link)).toBe(true);
        const current = node<HTMLSelectElement>(`#${kind}-selection`);
        current.value = workspace === "plans" ? "plan-default" : "default";
        current.dispatchEvent(new Event("change"));
        expect(node(`#${kind}-list article`).dataset[`${kind}Id`]).toBe(
          workspace === "plans" ? "plan-default" : "default",
        );
        expect(calls).toEqual([]);
        expect(data).toEqual(before);
        if (workspace === "plans")
          expect(button("#plan-list", "Apply reviewed plan").disabled).toBe(role !== "admin");
      } finally {
        node<HTMLButtonElement>("#logout").click();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    }
  }
});

it("a refused moved-history local review cannot retire the current pending original inspection and restored explicit navigation still can", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    release = done;
  });
  const data = state(),
    before = structuredClone(data),
    calls: string[] = [];
  let observations = 0;
  await boot(data, "operations", async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/observation")) return ++observations === 1 ? reply(observed) : pending;
    if (path.endsWith("/events")) return reply(rows);
    throw new Error(`Unexpected pending inspection request ${path}`);
  });
  try {
    button("#operation-list", "Inspect result & step events").click();
    await vi.waitFor(() => expect(node("#operation-events").textContent).toBe(JSON.stringify(rows, null, 2)));
    const inspect = button("#operation-list", "Inspect result & step events");
    await vi.waitFor(() => expect(inspect.disabled).toBe(false));
    inspect.click();
    expect(calls).toHaveLength(3);
    const card = node("#operation-list article"),
      review = card.parentElement,
      local = button("#operation-list", "Review original plan");
    if (!review) throw new Error("Missing pending original frame");
    expect(inspect.disabled).toBe(true);
    expect(local.disabled).toBe(false);
    node("#diagnostics").append(review);
    local.click();
    expect(window.location.hash).toBe("#/operations");
    expect(node("#notice").textContent).toBe("Working…");
    expect(calls).toHaveLength(3);
    node("#operation-list").append(review);
    release(reply(observed));
    await vi.waitFor(() => expect(node("#operation-events").textContent).toBe(JSON.stringify(rows, null, 2)));
    await vi.waitFor(() => expect(inspect.disabled).toBe(false));
    expect(calls).toEqual([
      "GET /api/v1/operations/original/observation",
      "GET /api/v1/operations/original/events",
      "GET /api/v1/operations/original/observation",
      "GET /api/v1/operations/original/events",
    ]);
    expect(node("#operation-export [data-operation-export]")).toBeDefined();
    local.click();
    await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
    expect(node("#plan-list article").dataset.planId).toBe("plan-original");
    expect(data).toEqual(before);
  } finally {
    release(reply(observed));
  }
});

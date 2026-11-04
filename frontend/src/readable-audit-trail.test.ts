import { afterEach, expect, it, vi } from "vitest";
import type { Snapshot } from "./generated";

const initial = (role: string): Snapshot => ({
  accounts: [],
  inventory: [],
  networks: [],
  operations: [],
  plans: [
    {
      id: "original-plan /+é",
      scope: "original-scope",
      scope_version: 0,
      inventory_revision: 1,
      network_revision: 1,
      request: {
        account_id: "original-account",
        vpc_id: "original-vpc",
        subnet_ids: ["original-subnet"],
        network_id: "original-network",
        allow_application_traffic: false,
      },
      actions: [
        {
          kind: "attachment",
          target: "original-vpc",
          requires: [],
          postcondition: "Original simulated attachment only",
        },
      ],
      digest: "original-digest",
    },
  ],
  role,
  mode: "demo",
  aws_accounts: [],
  aws_regions: [],
  aws_read_only_enabled: false,
});
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
}
const rows = () =>
  Array.from({ length: 8 }, (_, i) => ({
    actor: i === 0 ? "Operator <admin> /+é" : `actor-${i % 2}`,
    event: i === 0 ? "<recorded.event>" : `literal-event-${i}`,
    target: `original target ${7 - i} /+é`,
    at: `reported-time-${7 - i}`,
  }));
const summary = () => node('[aria-label="Returned audit trail"]');
const displayed = () =>
  [...summary().querySelectorAll<HTMLElement>("[data-audit-index]")].map((row) => ({
    index: Number(row.dataset.auditIndex),
    ...Object.fromEntries(
      ["actor", "event", "target", "at"].map((key) => [
        key,
        row.querySelector(`[data-audit-field="${key}"]`)?.textContent,
      ]),
    ),
  }));
afterEach(() => {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("reads returned audit records through the existing explicit action for admin and reader while preserving complete original evidence and immutable Plan", async () => {
  for (const role of ["admin", "read_only"]) {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, "", "#/diagnostics");
    const data = initial(role),
      records = rows(),
      before = structuredClone(data),
      original = structuredClone(records);
    const calls: { path: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input),
          method = init?.method ?? "GET";
        calls.push({ path, method });
        if (path === "/api/v1/snapshot") return new Response(JSON.stringify(data));
        if (path === "/api/v1/audit") return new Response(JSON.stringify(records));
        throw new Error(`Unexpected audit request ${path}`);
      }),
    );
    await import("./main");
    node<HTMLInputElement>("#token").value = `fixture-${role}`;
    node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(node("#diagnostics").hidden).toBe(false));
    expect(calls).toEqual([{ path: "/api/v1/snapshot", method: "GET" }]);
    node<HTMLButtonElement>("#audit").click();
    await vi.waitFor(() =>
      expect(node("#diagnostic-output").textContent).toBe(JSON.stringify(records, null, 2)),
    );
    expect(
      node("#diagnostics").textContent,
      "Existing explicit audit load must provide readable saved records",
    ).toContain("Returned audit trail");
    expect(summary().textContent).toContain("Showing 6 of 8 returned records");
    expect(summary().textContent).toContain("not the database total");
    expect(summary().textContent).toContain("not current operation state or connectivity measurements");
    expect(displayed()).toEqual(records.slice(0, 6).map((record, index) => ({ index, ...record })));
    expect(summary().querySelector("script, a, button, input, select")).toBeNull();
    expect(JSON.parse(node("#diagnostic-output").textContent ?? "null")).toEqual(original);
    expect(calls).toEqual([
      { path: "/api/v1/snapshot", method: "GET" },
      { path: "/api/v1/audit", method: "GET" },
    ]);
    expect(data).toEqual(before);
    expect(records).toEqual(original);
    // Generic workspace navigation clears both views without another read.
    node<HTMLAnchorElement>('nav a[href="#/overview"]').click();
    await vi.waitFor(() => expect(node("#overview").hidden).toBe(false));
    expect(document.querySelector('[aria-label="Returned audit trail"]')).toBeNull();
    expect(node("#diagnostic-output").textContent).toBe("");
    node<HTMLAnchorElement>('nav a[href="#/diagnostics"]').click();
    await vi.waitFor(() => expect(node("#diagnostics").hidden).toBe(false));
    expect(calls).toHaveLength(2);
    node<HTMLButtonElement>("#audit").click();
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Returned audit trail"]')).not.toBeNull(),
    );
    expect(displayed()).toEqual(records.slice(0, 6).map((record, index) => ({ index, ...record })));
    node<HTMLButtonElement>("#refresh").click();
    await vi.waitFor(() => expect(calls.filter((c) => c.path === "/api/v1/snapshot")).toHaveLength(2));
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Returned audit trail"]')).toBeNull());
    expect(node("#diagnostic-output").textContent).toBe("");
    expect(data.plans).toEqual(before.plans);
    node<HTMLButtonElement>("#logout").click();
    expect(document.querySelector('[aria-label="Returned audit trail"]')).toBeNull();
    expect(node("#diagnostic-output").textContent).toBe("");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  }
});

it("bounds only displayed records, preserves repeated rows and literal empty fields without interpreting timestamps or targets", async () => {
  const { renderAuditTrail } = await import("./readable-audit-trail");
  const repeated = {
    actor: "",
    event: "",
    target: "<img src=x onerror=alert(1)> /+é",
    at: "opaque reported time",
  };
  const records = [repeated, repeated, ...rows()];
  const original = structuredClone(records),
    rendered = renderAuditTrail(records);
  expect(rendered.textContent).toContain("Showing 6 of 10 returned records");
  const shown = [...rendered.querySelectorAll<HTMLElement>("[data-audit-index]")];
  expect(shown.map((row) => Number(row.dataset.auditIndex))).toEqual([0, 1, 2, 3, 4, 5]);
  for (const [index, row] of shown.entries())
    for (const key of ["actor", "event", "target", "at"] as const)
      expect(row.querySelector(`[data-audit-field="${key}"]`)?.textContent).toBe(records[index][key]);
  expect(rendered.textContent).toContain("reported empty string");
  expect(rendered.querySelector("img,script,a,input,select,button")).toBeNull();
  expect(records).toEqual(original);
  const empty = renderAuditTrail([]);
  expect(empty.textContent).toContain("Showing 0 of 0 returned records");
  expect(empty.textContent).toContain("No audit records returned");
  expect(empty.textContent).toContain("not proof of an empty database");
  expect(empty.querySelector("[data-audit-index]")).toBeNull();
  const complete = Array.from({ length: 1000 }, () => repeated);
  expect(renderAuditTrail(complete).textContent).toContain("Showing 6 of 1000 returned records");
});

it("refuses the entire readable prefix for sparse inherited malformed or excess captures while never guessing missing fields", async () => {
  const { renderAuditTrail } = await import("./readable-audit-trail");
  const sparse = rows();
  delete sparse[7];
  const inherited = rows();
  delete inherited[7];
  const prototype = Object.create(Array.prototype);
  prototype[7] = rows()[7];
  Object.setPrototypeOf(inherited, prototype);
  const inheritedField = rows();
  inheritedField[7] = Object.create(rows()[7]);
  const missing = rows();
  delete (missing[7] as Partial<(typeof missing)[number]>).at;
  const wrong = rows();
  wrong[7].target = null as unknown as string;
  for (const value of [
    undefined,
    null,
    {},
    "[]",
    sparse,
    inherited,
    inheritedField,
    missing,
    wrong,
    Array.from({ length: 1001 }, () => rows()[0]),
  ]) {
    const rendered = renderAuditTrail(value);
    expect(rendered.textContent).toContain("Readable audit context unavailable or malformed");
    expect(rendered.querySelector("[data-audit-index]")).toBeNull();
    expect(rendered.textContent).not.toContain("Operator <admin>");
  }
});

it("retires pending audit publication on navigation Refresh and logout, leaves newer work owned, and permits only explicit recovery after errors", async () => {
  for (const seam of ["navigation", "refresh", "logout"] as const) {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, "", "#/diagnostics");
    const data = initial("read_only"),
      before = structuredClone(data);
    const pending: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        calls.push(path);
        if (path === "/api/v1/snapshot") return Promise.resolve(new Response(JSON.stringify(data)));
        if (path === "/api/v1/audit")
          return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
        throw new Error(`Unexpected audit qualification ${path}`);
      }),
    );
    await import("./main");
    const login = async () => {
      node<HTMLInputElement>("#token").value = "fixture-reader";
      node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.waitFor(() => expect(node("#diagnostics").hidden).toBe(false));
    };
    await login();
    node<HTMLButtonElement>("#audit").click();
    expect(pending).toHaveLength(1);
    expect(node<HTMLButtonElement>("#audit").disabled).toBe(true);
    node("#audit").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(pending).toHaveLength(1);
    if (seam === "navigation") {
      node<HTMLAnchorElement>('nav a[href="#/overview"]').click();
      await vi.waitFor(() => expect(node("#overview").hidden).toBe(false));
      node<HTMLAnchorElement>('nav a[href="#/diagnostics"]').click();
      await vi.waitFor(() => expect(node("#diagnostics").hidden).toBe(false));
    } else if (seam === "refresh") {
      node<HTMLButtonElement>("#refresh").click();
      await vi.waitFor(() => expect(node<HTMLButtonElement>("#audit").disabled).toBe(false));
    } else {
      node<HTMLButtonElement>("#logout").click();
      await login();
    }
    expect(node("#diagnostic-output").textContent).toBe("");
    expect(document.querySelector('[aria-label="Returned audit trail"]')).toBeNull();
    node<HTMLButtonElement>("#audit").click();
    expect(pending).toHaveLength(2);
    // Fetch ignores abort. The retired completion must not publish or unlock this pending read.
    pending[0].resolve(
      new Response(
        JSON.stringify([
          { actor: "retired actor", event: "retired event", target: "retired target", at: "retired time" },
        ]),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(node<HTMLButtonElement>("#audit").disabled).toBe(true);
    expect(node("#diagnostic-output").textContent).toBe("");
    expect(node("#notice").textContent).toBe("Working…");
    pending[1].resolve(new Response(JSON.stringify(rows())));
    await vi.waitFor(() => expect(node<HTMLButtonElement>("#audit").disabled).toBe(false));
    expect(displayed()).toEqual(
      rows()
        .slice(0, 6)
        .map((record, index) => ({ index, ...record })),
    );
    expect(JSON.parse(node("#diagnostic-output").textContent ?? "null")).toEqual(rows());
    node<HTMLButtonElement>("#audit").click();
    expect(pending).toHaveLength(3);
    expect(document.querySelector('[aria-label="Returned audit trail"]')).toBeNull();
    expect(node("#diagnostic-output").textContent).toBe("");
    pending[2].reject(new Error("Audit unavailable, original cause"));
    await vi.waitFor(() => expect(node("#notice").textContent).toBe("Audit unavailable, original cause"));
    expect(node<HTMLButtonElement>("#audit").disabled).toBe(false);
    expect(pending).toHaveLength(3);
    node<HTMLButtonElement>("#audit").click();
    expect(pending).toHaveLength(4);
    const malformed = { actor: "raw incomplete original" };
    pending[3].resolve(new Response(JSON.stringify(malformed)));
    await vi.waitFor(() => expect(summary().textContent).toContain("Readable audit context unavailable"));
    expect(JSON.parse(node("#diagnostic-output").textContent ?? "null")).toEqual(malformed);
    expect(summary().querySelector("[data-audit-index]")).toBeNull();
    expect(calls.filter((path) => path === "/api/v1/audit")).toHaveLength(4);
    expect(data).toEqual(before);
    node<HTMLButtonElement>("#logout").click();
    expect(node("#diagnostic-output").textContent).toBe("");
    expect(document.querySelector('[aria-label="Returned audit trail"]')).toBeNull();
  }
});

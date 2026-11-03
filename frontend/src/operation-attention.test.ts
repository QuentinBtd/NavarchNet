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
  actions: [{ kind: "attachment", target: id, requires: [], postcondition: "Simulation only" }],
  digest: `digest-${id}`,
});
const operation = (id: string, status: string, error: string | null = null): Operation => ({
  id,
  plan_id: `plan-${id}`,
  scope: `scope-${id}`,
  status,
  error,
  step: 0,
  attempts: 0,
  fault: "none",
});
function state(role: string): Snapshot {
  const operations = [
    operation("default", "succeeded"),
    operation("queued", "queued"),
    operation("failed", "failed", "Permission <literal> denied"),
    operation("partial /+é", "partial", "Return routing retained; manual review"),
  ];
  return {
    accounts: [],
    inventory: [],
    networks: [],
    plans: operations.map((o) => plan(o.id)),
    operations,
    role,
    mode: "demo",
    aws_accounts: [],
    aws_regions: [],
    aws_read_only_enabled: false,
  };
}
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
function button(mount: string, label: string) {
  const found = [...node(mount).querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function navigate(href: string, workspace: string) {
  const link = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Workspace"] a')].find(
    (a) => a.getAttribute("href") === href,
  );
  if (!link) throw new Error(`Missing route ${href}`);
  link.click();
  await vi.waitFor(() => expect(node(workspace).hidden).toBe(false));
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("surfaces returned failure attention on Overview and explicitly reviews the exact original operation without implicit reads or writes", async () => {
  for (const role of ["admin", "read_only"]) {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, "", "#/overview");
    const data = state(role),
      original = structuredClone(data);
    const partial = data.operations[3],
      originalPlan = data.plans[3];
    const observation: Observation = {
      operation_id: partial.id,
      configuration: "Captured simulation",
      calculated_path: "Not measured",
      public_ips: [],
      connectivity: "Not tested",
      active_probe: "Not tested",
      drift: false,
      recovery: "Manual review",
    };
    const events = [{ step: 0, fence: 1, outcome: "partial literal", at: "opaque-time" }];
    const calls: { path: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        calls.push({ path, method: init?.method ?? "GET" });
        if (path === "/api/v1/snapshot") return new Response(JSON.stringify(data));
        if (path === `/api/v1/operations/${partial.id}/observation`)
          return new Response(JSON.stringify(observation));
        if (path === `/api/v1/operations/${partial.id}/events`) return new Response(JSON.stringify(events));
        throw new Error(`Unexpected attention request ${path}`);
      }),
    );
    await import("./main");
    node<HTMLInputElement>("#token").value = "fixture-only";
    node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(node("#overview").hidden).toBe(false));
    await vi.waitFor(() => expect(node<HTMLSelectElement>("#operation-selection").value).toBe("default"));
    expect(
      node("#overview").textContent,
      "Overview must surface saved failures, not just operation totals",
    ).toContain("Returned operation attention");
    const summary = node('[aria-label="Returned operation attention"]');
    expect(summary.textContent).toContain("4 returned operations");
    expect(summary.textContent).toContain("2 failed/partial");
    expect(summary.textContent).toContain("1 queued/running/retrying");
    expect(summary.textContent).toContain("bounded history");
    expect(summary.textContent).toContain("not connectivity");
    const rows = [...summary.querySelectorAll<HTMLElement>("[data-attention-operation]")];
    expect(rows.map((row) => row.dataset.attentionOperation)).toEqual(["failed", partial.id]);
    expect(rows[0].textContent).toContain(original.operations[2].error);
    expect(rows[1].textContent).toContain(partial.error);
    expect(summary.querySelector("literal")).toBeNull();
    expect(calls).toEqual([{ path: "/api/v1/snapshot", method: "GET" }]);
    expect(node<HTMLSelectElement>("#operation-selection").value).toBe("default");
    const link = rows[1].querySelector<HTMLAnchorElement>("a");
    if (!link) throw new Error("Missing exact attention operation link");
    expect(link.getAttribute("href")).toBe(`#/operations?operation=${encodeURIComponent(partial.id)}`);
    link.click();
    await vi.waitFor(() => expect(node("#operations").hidden).toBe(false));
    expect(node<HTMLSelectElement>("#operation-selection").value).toBe(partial.id);
    expect(JSON.parse(node("#operation-list article details pre").textContent ?? "null")).toEqual(partial);
    expect(node("#operation-list article").textContent).toContain(partial.error);
    expect(calls).toHaveLength(1);
    button("#operation-list", "Review original plan").click();
    await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
    expect(node<HTMLSelectElement>("#plan-selection").value).toBe(originalPlan.id);
    expect(JSON.parse(node("#plan-list article details pre").textContent ?? "null")).toEqual(originalPlan);
    expect(button("#plan-list", "Apply reviewed plan").disabled).toBe(role !== "admin");
    await navigate("#/overview", "#overview");
    const current = [
      ...node('[aria-label="Returned operation attention"]').querySelectorAll<HTMLAnchorElement>("a"),
    ].find((a) => a.getAttribute("href") === link.getAttribute("href"));
    if (!current) throw new Error("Missing restored explicit attention link");
    current.click();
    await vi.waitFor(() => expect(node("#operations").hidden).toBe(false));
    button("#operation-list", "Inspect result & step events").click();
    await vi.waitFor(() => expect(node("#operation-events").textContent).toContain("partial literal"));
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/snapshot",
      `/api/v1/operations/${partial.id}/observation`,
      `/api/v1/operations/${partial.id}/events`,
    ]);
    expect(data).toEqual(original);
    await navigate("#/overview", "#overview");
    const oldLink = node<HTMLAnchorElement>("[data-attention-operation] a");
    for (const op of data.operations) {
      op.status = "succeeded";
      op.error = null;
    }
    node<HTMLButtonElement>("#refresh").click();
    await vi.waitFor(() =>
      expect(node('[aria-label="Returned operation attention"]').textContent).toContain("0 failed/partial"),
    );
    expect(
      node('[aria-label="Returned operation attention"]').querySelectorAll("[data-attention-operation]"),
    ).toHaveLength(0);
    expect(oldLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(false);
    expect(node("#overview").hidden).toBe(false);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    node<HTMLButtonElement>("#logout").click();
    expect(document.querySelector('[aria-label="Returned operation attention"]')).toBeNull();
    expect(node("#workspace").hidden).toBe(true);
  }
});

it("keeps attention bounded in returned order with literal unknown/error values and a complete-history escape", async () => {
  const { renderOperationAttention } = await import("./operation-attention");
  const rows = Array.from({ length: 8 }, (_, i) =>
    operation(`row-${i}`, i % 2 ? "partial" : "failed", i === 0 ? "" : i === 1 ? null : `<img src=x> ${i}`),
  );
  rows.push(
    operation("active", "retrying"),
    operation("done", "succeeded"),
    operation("other", "unrecognized-literal"),
  );
  const before = structuredClone(rows);
  let live = true;
  const root = renderOperationAttention(rows, () => live);
  document.body.append(root);
  expect(root.textContent).toContain(
    "11 returned operations · 8 failed/partial · 1 queued/running/retrying · 1 succeeded · 1 other statuses",
  );
  expect(root.textContent).toContain("Showing 6 of 8");
  expect(
    [...root.querySelectorAll<HTMLElement>("[data-attention-operation]")].map(
      (n) => n.dataset.attentionOperation,
    ),
  ).toEqual(rows.slice(0, 6).map((r) => r.id));
  expect(root.textContent).toContain('"" (empty error string)');
  expect(root.textContent).toContain("No error recorded.");
  expect(root.textContent).toContain("<img src=x> 2");
  expect(root.querySelector("img")).toBeNull();
  const links = [...root.querySelectorAll<HTMLAnchorElement>("a")];
  expect(links.at(-1)?.getAttribute("href")).toBe("#/operations");
  const click = () => {
    const event = new MouseEvent("click", { cancelable: true });
    links[0].addEventListener("click", (e) => e.preventDefault(), { once: true });
    return event;
  };
  // Observe the renderer's cancellation before suppressing fixture-only default navigation.
  let admitted = false;
  links[0].addEventListener("click", (e) => {
    admitted = !e.defaultPrevented;
  });
  links[0].dispatchEvent(click());
  expect(admitted).toBe(true);
  live = false;
  links[0].dispatchEvent(click());
  expect(admitted).toBe(false);
  live = true;
  rows[7].error = "changed original capture";
  links[0].dispatchEvent(click());
  expect(admitted).toBe(false);
  rows[7].error = before[7].error;
  links[0].dispatchEvent(click());
  expect(admitted).toBe(true);
  root.remove();
  links[0].dispatchEvent(click());
  expect(admitted).toBe(false);
  expect(rows).toEqual(before);
});

it("keeps empty history unknown and refuses ambiguous or incomplete collections before any attention prefix", async () => {
  const { renderOperationAttention } = await import("./operation-attention");
  const empty = renderOperationAttention([], () => true);
  expect(empty.textContent).toContain("0 returned operations");
  expect(empty.textContent).toContain("absence here does not establish health");
  const rows = Array.from({ length: 9 }, (_, i) => operation(`case-${i}`, "failed", "literal error"));
  const duplicate = [...rows, { ...rows[0] }];
  const sparse = [...rows];
  sparse.length++;
  const malformed = [...rows];
  malformed[8] = { ...rows[8], error: undefined as unknown as null };
  for (const values of [duplicate, sparse, malformed]) {
    const root = renderOperationAttention(values, () => true);
    expect(root.textContent).toContain("unavailable or ambiguous");
    expect(root.querySelector("[data-attention-operation]")).toBeNull();
    expect(root.querySelector("a")).toBeNull();
  }
});

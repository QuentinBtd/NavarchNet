import { afterEach, expect, it, vi } from "vitest";
import type { Snapshot } from "./generated";

const state = (): Snapshot => ({
  accounts: [],
  inventory: [],
  networks: [],
  operations: [],
  plans: ["first", "second"].map((id) => ({
    id,
    scope: "scope",
    scope_version: 1,
    inventory_revision: 2,
    network_revision: 3,
    digest: `digest-${id}`,
    request: {
      account_id: "account",
      vpc_id: "vpc",
      network_id: "network",
      subnet_ids: ["subnet"],
      allow_application_traffic: false,
    },
    actions: [{ kind: "attachment", target: "vpc", requires: [], postcondition: "simulated available" }],
  })),
  mode: "demo",
  role: "read_only",
  aws_accounts: [],
  aws_regions: [],
  aws_read_only_enabled: false,
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reports only browser network hints and preserves local original-plan reading without automatic requests", async () => {
  vi.resetModules();
  let online = true;
  vi.spyOn(Navigator.prototype, "onLine", "get").mockImplementation(() => online);
  const snapshot = state(),
    fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/snapshot") return new Response(JSON.stringify(snapshot));
      throw new Error(`Unexpected request ${String(input)}`);
    });
  vi.stubGlobal("fetch", fetcher);
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/plans");
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  if (!token) throw new Error("Missing login");
  token.value = "fixture-reader";
  document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelectorAll("#plan-list article")).toHaveLength(1));
  const original = document.querySelector("#plan-list article"),
    calls = fetcher.mock.calls.length;
  online = false;
  window.dispatchEvent(new Event("offline"));
  const hint = document.querySelector("#browser-network-notice");
  expect(hint).not.toBeNull();
  expect(hint?.textContent).toContain("Browser reports offline.");
  expect(hint?.textContent).toContain("server reachability and connectivity are unknown");
  expect(document.querySelector("#plan-list article")).toBe(original);
  expect(fetcher.mock.calls.length).toBe(calls);
  const picker = document.querySelector<HTMLSelectElement>("#plan-selection");
  if (!picker) throw new Error("Missing plan picker");
  picker.value = "second";
  picker.dispatchEvent(new Event("change"));
  expect(JSON.parse(document.querySelector("#plan-list article details pre")?.textContent ?? "null")).toEqual(
    snapshot.plans[1],
  );
  expect(fetcher.mock.calls.length).toBe(calls);
  online = true;
  window.dispatchEvent(new Event("online"));
  expect(hint?.textContent).toContain("Browser reports online.");
  expect(hint?.textContent).toContain("Refresh explicitly");
  expect(fetcher.mock.calls.length).toBe(calls);
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(calls + 1));
  await vi.waitFor(() => expect(hint?.textContent).toBe(""));
  expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("second");
});

it("keeps reconnect guidance after failed reads and refuses logged-out or moved hint publication", async () => {
  vi.resetModules();
  let online = true,
    fail = false;
  vi.spyOn(Navigator.prototype, "onLine", "get").mockImplementation(() => online);
  const snapshot = state();
  snapshot.role = "admin";
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(fail ? { error: "Saved read unavailable" } : snapshot), {
        status: fail ? 503 : 200,
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "#/plans");
  await import("./main");
  const hint = document.querySelector<HTMLElement>("#browser-network-notice");
  if (!hint) throw new Error("Missing browser hint");
  const login = async () => {
    const token = document.querySelector<HTMLInputElement>("#token");
    if (!token) throw new Error("Missing login");
    token.value = "fixture-admin";
    document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector("#plans")?.hasAttribute("hidden")).toBe(false));
  };
  window.dispatchEvent(new Event("offline"));
  expect(hint.hidden).toBe(true);
  expect(hint.textContent).toBe("");
  await login();
  expect(hint.hidden).toBe(true);
  // The event name is not evidence: read the actual browser property.
  window.dispatchEvent(new Event("offline"));
  expect(hint.hidden).toBe(true);
  online = false;
  window.dispatchEvent(new Event("online"));
  expect(hint.textContent).toContain("Browser reports offline.");
  const apply = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "Apply reviewed plan",
  );
  expect(apply?.disabled).toBe(false);
  const original = document.querySelector("#plan-list article"),
    parent = hint.parentElement;
  if (!parent) throw new Error("Missing hint parent");
  document.querySelector("#plans")?.append(hint);
  online = true;
  window.dispatchEvent(new Event("online"));
  expect(hint.textContent).toContain("Browser reports offline.");
  parent.prepend(hint);
  window.dispatchEvent(new Event("online"));
  expect(hint.textContent).toContain("Refresh explicitly");
  fail = true;
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() =>
    expect(document.querySelector("#notice")?.textContent).toBe("Saved read unavailable"),
  );
  expect(hint.textContent).toContain("Browser reports online.");
  expect(hint.textContent).toContain("Refresh explicitly");
  expect(document.querySelector("#plan-list article")).toBe(original);
  fail = false;
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(hint.hidden).toBe(true));
  online = false;
  window.dispatchEvent(new Event("offline"));
  expect(hint.hidden).toBe(false);
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  expect(hint.hidden).toBe(true);
  expect(hint.textContent).toBe("");
  online = true;
  window.dispatchEvent(new Event("online"));
  expect(hint.hidden).toBe(true);
  await login();
  expect(hint.hidden).toBe(true);
  expect(hint.textContent).toBe("");
  const calls = fetcher.mock.calls.length;
  hint.remove();
  online = false;
  window.dispatchEvent(new Event("offline"));
  expect(hint.textContent).toBe("");
  expect(fetcher.mock.calls.length).toBe(calls);
  document.body.replaceChildren();
  expect(() => window.dispatchEvent(new Event("online"))).not.toThrow();
});

it("does not let an ignored-abort older read clear a newer session's browser hint", async () => {
  let online = true;
  vi.spyOn(Navigator.prototype, "onLine", "get").mockImplementation(() => online);
  for (const oldStatus of [200, 503]) {
    vi.resetModules();
    online = true;
    const snapshot = state();
    let resolve: ((response: Response) => void) | undefined,
      count = 0;
    const fetcher = vi.fn(async () => {
      count++;
      if (count === 2)
        return new Promise<Response>((done) => {
          resolve = done;
        });
      return new Response(JSON.stringify(snapshot));
    });
    vi.stubGlobal("fetch", fetcher);
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, "", "#/plans");
    await import("./main");
    const login = async () => {
      const token = document.querySelector<HTMLInputElement>("#token");
      if (!token) throw new Error("Missing login");
      token.value = "fixture-reader";
      document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.waitFor(() => expect(document.querySelector("#plans")?.hasAttribute("hidden")).toBe(false));
    };
    await login();
    document.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    document.querySelector<HTMLButtonElement>("#logout")?.click();
    await login();
    online = false;
    window.dispatchEvent(new Event("offline"));
    const hint = document.querySelector<HTMLElement>("#browser-network-notice");
    if (!hint) throw new Error("Missing browser hint");
    const current = document.querySelector("#plan-list article"),
      message = document.querySelector("#notice")?.textContent;
    expect(hint.textContent).toContain("Browser reports offline.");
    resolve?.(
      new Response(JSON.stringify(oldStatus === 200 ? snapshot : { error: "Old unavailable response" }), {
        status: oldStatus,
      }),
    );
    await new Promise((done) => setTimeout(done, 10));
    expect(hint.textContent).toContain("Browser reports offline.");
    expect(hint.hidden).toBe(false);
    expect(document.querySelector("#plan-list article")).toBe(current);
    expect(document.querySelector("#notice")?.textContent).toBe(message);
    expect(fetcher).toHaveBeenCalledTimes(3);
  }
});

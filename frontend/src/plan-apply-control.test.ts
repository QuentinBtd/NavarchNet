import { afterEach, expect, it, vi } from "vitest";
import type { Operation, Plan, Snapshot } from "./generated";

const plan = (id: string): Plan => ({
  id,
  scope: "app:vpc",
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
const operation = (id: string, source: Plan): Operation => ({
  id,
  plan_id: source.id,
  scope: source.scope,
  status: "queued",
  step: 0,
  attempts: 0,
  error: null,
  fault: "none",
});
const reply = (value: unknown) => new Response(JSON.stringify(value));
function deferred() {
  let resolve!: (value: Response) => void;
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
afterEach(() => {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("admits original Plan Apply only from its original mounted review and preserves the complete explicit handoff", async () => {
  for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
    document.querySelector<HTMLButtonElement>("#logout")?.click();
    vi.resetModules();
    const original = plan("reviewed-original"),
      other = plan("other-plan"),
      admitted = operation("acknowledged-original-operation", original),
      historical = operation("different-default-operation", other),
      post = deferred(),
      followup = deferred();
    const data: Snapshot = {
      accounts: [],
      inventory: [],
      networks: [],
      plans: [other, original],
      operations: [historical],
      mode: "demo",
      role: "admin",
      aws_accounts: [],
      aws_read_only_enabled: false,
      aws_regions: [],
    };
    const before = structuredClone(data);
    const writes: { path: string; body: unknown }[] = [];
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/v1/snapshot") return ++reads === 1 ? reply(data) : followup.promise;
        writes.push({ path, body: JSON.parse(String(init?.body)) });
        if (path === `/api/v1/plans/${original.id}/apply`) return post.promise;
        throw new Error(`Unexpected original Apply path ${path}`);
      }),
    );
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, "", "#/plans");
    await import("./main");
    node<HTMLInputElement>("#token").value = "fixture-admin";
    node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelectorAll("#plan-list article")).toHaveLength(1));
    node<HTMLSelectElement>("#plan-selection").value = original.id;
    node("#plan-selection").dispatchEvent(new Event("change"));
    const card = node("#plan-list article"),
      review = card.parentElement,
      mount = node("#plan-list"),
      apply = node<HTMLButtonElement>("#plan-list article button[data-write]");
    if (!review) throw new Error("Missing original review root");
    const next = apply.nextSibling;
    expect(card.getAttribute("data-plan-id")).toBe(original.id);
    expect(JSON.parse(node("#plan-list article details pre").textContent ?? "null")).toEqual(original);
    expect(apply.isConnected && review.contains(apply) && mount.contains(review)).toBe(true);
    expect(apply.disabled).toBe(false);
    expect(writes).toEqual([]);
    const notice = node("#notice").textContent;
    try {
      if (displacement === "removed-control") apply.remove();
      else if (displacement === "moved-control") node("#diagnostics").append(apply);
      else if (displacement === "removed-review") review.remove();
      else node("#diagnostics").append(review);
      apply.dispatchEvent(new MouseEvent("click"));
      expect(writes, displacement).toEqual([]);
      expect(node("#notice").textContent).toBe(notice);
      expect(data).toEqual(before);
      await new Promise((done) => setTimeout(done, 0));
      expect(writes).toEqual([]);
      if (displacement.endsWith("control")) card.insertBefore(apply, next);
      else mount.append(review);
      expect(apply.isConnected && mount.contains(review)).toBe(true);
      apply.click();
      expect(writes).toEqual([{ path: `/api/v1/plans/${original.id}/apply`, body: { fault: "none" } }]);
      expect(apply.disabled).toBe(true);
      const working = node("#notice").textContent;
      apply.click();
      apply.dispatchEvent(new MouseEvent("click"));
      expect(writes).toHaveLength(1);
      expect(node("#notice").textContent).toBe(working);
      expect(data).toEqual(before);
      data.operations = [historical, admitted];
      post.resolve(reply(admitted));
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(apply.disabled).toBe(true);
      apply.dispatchEvent(new MouseEvent("click"));
      expect(writes).toHaveLength(1);
      expect(node("#plans").hidden).toBe(false);
      followup.resolve(reply(data));
      await vi.waitFor(() => expect(node("#operations").hidden).toBe(false));
      expect(node("#operation-list article").getAttribute("data-operation-id")).toBe(admitted.id);
      expect(JSON.parse(node("#operation-list article details pre").textContent ?? "null")).toEqual(admitted);
      expect(data.plans).toEqual(before.plans);
      expect(writes).toHaveLength(1);
    } finally {
      node<HTMLButtonElement>("#logout").click();
      post.resolve(reply(admitted));
      followup.resolve(reply(data));
    }
  }
});

it("retires a pending Apply at a removed review before followup reads and recovers the acknowledged operation only explicitly", async () => {
  for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
    document.querySelector<HTMLButtonElement>("#logout")?.click();
    vi.resetModules();
    const original = plan("pending-original"),
      admitted = operation("retired-acknowledged-operation", original),
      post = deferred();
    const data: Snapshot = {
      accounts: [],
      inventory: [],
      networks: [],
      plans: [original],
      operations: [],
      mode: "demo",
      role: "admin",
      aws_accounts: [],
      aws_read_only_enabled: false,
      aws_regions: [],
    };
    const before = structuredClone(original);
    let reads = 0,
      writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/v1/snapshot") {
          reads++;
          return reply(data);
        }
        if (path === `/api/v1/plans/${original.id}/apply`) {
          writes++;
          return post.promise;
        }
        throw new Error(`Unexpected retired Apply path ${path}`);
      }),
    );
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, "", "#/plans");
    await import("./main");
    node<HTMLInputElement>("#token").value = "fixture-admin";
    node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelectorAll("#plan-list article")).toHaveLength(1));
    const apply = node<HTMLButtonElement>("#plan-list article button[data-write]"),
      review = node("#plan-list article").parentElement;
    if (!review) throw new Error("Missing pending review root");
    try {
      apply.click();
      expect(writes).toBe(1);
      expect(apply.disabled).toBe(true);
      if (displacement === "removed-control") apply.remove();
      else if (displacement === "moved-control") node("#diagnostics").append(apply);
      else if (displacement === "removed-review") review.remove();
      else node("#diagnostics").append(review);
      data.operations = [admitted];
      const acknowledged = reply(admitted);
      post.resolve(acknowledged);
      await vi.waitFor(() => expect(acknowledged.bodyUsed).toBe(true));
      await new Promise((done) => setTimeout(done, 0));
      expect(reads, displacement).toBe(1);
      expect(window.location.hash).toBe("#/plans");
      expect(apply.disabled).toBe(true);
      expect(writes).toBe(1);
      expect(data.plans).toEqual([before]);
      node<HTMLButtonElement>("#refresh").click();
      await vi.waitFor(() => expect(node("#notice").textContent).toContain("Updated."));
      expect(reads).toBe(2);
      expect(node<HTMLButtonElement>("#plan-list article button[data-write]").disabled).toBe(false);
      apply.disabled = false;
      apply.dispatchEvent(new MouseEvent("click"));
      expect(writes).toBe(1);
      node<HTMLAnchorElement>('nav[aria-label="Workspace"] a[href="#/operations"]').click();
      await vi.waitFor(() => expect(node("#operations").hidden).toBe(false));
      node<HTMLSelectElement>("#operation-selection").value = admitted.id;
      node("#operation-selection").dispatchEvent(new Event("change"));
      expect(node("#operation-list article").getAttribute("data-operation-id")).toBe(admitted.id);
      expect(JSON.parse(node("#operation-list article details pre").textContent ?? "null")).toEqual(admitted);
      expect(data.plans).toEqual([before]);
      expect(writes).toBe(1);
    } finally {
      node<HTMLButtonElement>("#logout").click();
      post.resolve(reply(admitted));
    }
  }
});

it("discards an Apply followup snapshot when its original review is removed before publication and requires explicit recovery", async () => {
  for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
    document.querySelector<HTMLButtonElement>("#logout")?.click();
    vi.resetModules();
    const original = plan("pending-original"),
      admitted = operation("retired-acknowledged-operation", original),
      post = deferred(),
      followup = deferred();
    const data: Snapshot = {
      accounts: [],
      inventory: [],
      networks: [],
      plans: [original],
      operations: [],
      mode: "demo",
      role: "admin",
      aws_accounts: [],
      aws_read_only_enabled: false,
      aws_regions: [],
    };
    const before = structuredClone(original);
    let reads = 0,
      writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/v1/snapshot") {
          return ++reads === 2 ? followup.promise : reply(data);
        }
        if (path === `/api/v1/plans/${original.id}/apply`) {
          writes++;
          return post.promise;
        }
        throw new Error(`Unexpected retired Apply path ${path}`);
      }),
    );
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, "", "#/plans");
    await import("./main");
    node<HTMLInputElement>("#token").value = "fixture-admin";
    node("#login").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelectorAll("#plan-list article")).toHaveLength(1));
    const apply = node<HTMLButtonElement>("#plan-list article button[data-write]"),
      review = node("#plan-list article").parentElement;
    if (!review) throw new Error("Missing pending review root");
    try {
      apply.click();
      expect(writes).toBe(1);
      expect(apply.disabled).toBe(true);
      data.operations = [admitted];
      post.resolve(reply(admitted));
      await vi.waitFor(() => expect(reads).toBe(2));
      if (displacement === "removed-control") apply.remove();
      else if (displacement === "moved-control") node("#diagnostics").append(apply);
      else if (displacement === "removed-review") review.remove();
      else node("#diagnostics").append(review);
      data.operations = [admitted];
      const acknowledged = reply(data);
      followup.resolve(acknowledged);
      await vi.waitFor(() => expect(acknowledged.bodyUsed).toBe(true));
      await new Promise((done) => setTimeout(done, 0));
      expect(document.querySelectorAll("#operation-list article"), displacement).toHaveLength(0);
      expect(reads).toBe(2);
      expect(window.location.hash).toBe("#/plans");
      expect(apply.disabled).toBe(true);
      expect(writes).toBe(1);
      expect(data.plans).toEqual([before]);
      node<HTMLButtonElement>("#refresh").click();
      await vi.waitFor(() => expect(node("#notice").textContent).toContain("Updated."));
      expect(reads).toBe(3);
      expect(node<HTMLButtonElement>("#plan-list article button[data-write]").disabled).toBe(false);
      apply.disabled = false;
      apply.dispatchEvent(new MouseEvent("click"));
      expect(writes).toBe(1);
      node<HTMLAnchorElement>('nav[aria-label="Workspace"] a[href="#/operations"]').click();
      await vi.waitFor(() => expect(node("#operations").hidden).toBe(false));
      node<HTMLSelectElement>("#operation-selection").value = admitted.id;
      node("#operation-selection").dispatchEvent(new Event("change"));
      expect(node("#operation-list article").getAttribute("data-operation-id")).toBe(admitted.id);
      expect(JSON.parse(node("#operation-list article details pre").textContent ?? "null")).toEqual(admitted);
      expect(data.plans).toEqual([before]);
      expect(writes).toBe(1);
    } finally {
      node<HTMLButtonElement>("#logout").click();
      post.resolve(reply(admitted));
      followup.resolve(reply(data));
    }
  }
});

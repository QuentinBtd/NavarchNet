import { afterEach, expect, it, vi } from "vitest";
import type { Account, ConnectionRequest, Plan, Snapshot } from "./generated";

const initial = (): Snapshot => ({
  accounts: [
    {
      id: "original-account",
      name: "Original application",
      provider: "fake",
      revision: 1,
      role_arn: "fake:original",
    },
  ],
  inventory: [
    {
      account_id: "original-account",
      vpc_id: "original-vpc",
      region: "eu-west-1",
      cidr: "10.10.0.0/16",
      revision: 1,
      subnets: [
        { id: "original-subnet", az_id: "az-1", route_table: "original-table", default_route_managed: true },
      ],
    },
  ],
  networks: [
    {
      id: "original-network",
      name: "Original network",
      region: "eu-west-1",
      revision: 1,
      egress_cidr: "10.250.0.0/16",
      az_ids: ["az-1"],
      public_ips: [],
      application_cidrs: [],
      managed_nat: true,
    },
  ],
  plans: [
    {
      id: "immutable-before-creation",
      scope: "original-account:original-vpc",
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
      actions: [],
      digest: "original-digest",
    },
  ],
  operations: [],
  role: "admin",
  mode: "demo",
  aws_accounts: [],
  aws_regions: [],
  aws_read_only_enabled: false,
});
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}
const submit = (form: string) => node(form).dispatchEvent(new Event("submit", { cancelable: true }));
afterEach(() => {
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
const cases = [
  {
    route: "accounts",
    form: "#register",
    input: "#account-name",
    path: "/api/v1/accounts",
    label: "Simulation account",
    name: "Another application",
    id: "created-account-literal",
  },
  {
    route: "networks",
    form: "#network-form",
    input: "#network-name",
    path: "/api/v1/networks",
    label: "Regional network",
    name: "Another regional network",
    id: "created-network-literal",
  },
] as const;

async function journey(kind: (typeof cases)[number], duplicate: boolean) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", `#/${kind.route}`);
  const data = initial();
  const oldPlan = structuredClone(data.plans[0]);
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let release: (() => void) | undefined;
  let failSnapshot = false;
  let generated: Plan | undefined;
  const account: Account = { ...data.accounts[0], id: kind.id, name: kind.name, role_arn: "fake:demo-role" };
  const network = { ...data.networks[0], id: kind.id, name: kind.name };
  const created = kind.route === "accounts" ? account : network;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input),
        method = init?.method ?? "GET";
      calls.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === "/api/v1/snapshot") {
        if (failSnapshot) {
          failSnapshot = false;
          return new Response(JSON.stringify({ error: "Snapshot temporarily unavailable" }), { status: 503 });
        }
        return new Response(JSON.stringify(data));
      }
      if (path === kind.path && method === "POST") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (kind.route === "accounts") data.accounts.push(account);
        else data.networks.push(network);
        failSnapshot = true;
        return new Response(JSON.stringify(created));
      }
      if (path === `/api/v1/accounts/${kind.id}/discover` && method === "POST") {
        const inventory = {
          ...data.inventory[0],
          account_id: kind.id,
          vpc_id: "created-account-vpc",
          cidr: "10.20.0.0/16",
          subnets: [
            {
              ...data.inventory[0].subnets[0],
              id: "created-account-subnet",
              route_table: "created-account-table",
            },
          ],
        };
        data.inventory.push(inventory);
        return new Response(JSON.stringify(inventory));
      }
      if (path === "/api/v1/plans" && method === "POST") {
        const request = JSON.parse(String(init?.body)) as ConnectionRequest;
        generated = {
          ...oldPlan,
          id: "new-explicit-original-plan",
          scope: `${request.account_id}:${request.vpc_id}`,
          request,
          digest: "new-original-digest",
        };
        data.plans.unshift(generated);
        return new Response(JSON.stringify(generated));
      }
      throw new Error(`Unexpected creation journey request ${method} ${path}`);
    }),
  );
  await import("./main");
  node<HTMLInputElement>("#token").value = "fixture-admin";
  submit("#login");
  await vi.waitFor(() => expect(node(`#${kind.route}`).hidden).toBe(false));
  const form = node<HTMLFormElement>(kind.form);
  const disclosure = form.closest("details");
  if (!disclosure) throw new Error("Missing existing creation disclosure");
  disclosure.open = true;
  node<HTMLInputElement>(kind.input).value = kind.name;
  const control = node<HTMLButtonElement>(`${kind.form} button[data-write]`);
  submit(kind.form);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  if (duplicate) {
    submit(kind.form);
    expect(
      calls.filter((c) => c.path === kind.path),
      "Pending simulation creation must refuse duplicate submits",
    ).toHaveLength(1);
    expect(control.disabled).toBe(true);
    expect(node("#notice").textContent).toBe("Working…");
  }
  node<HTMLInputElement>(kind.input).value = "Edited while pending, not the admitted payload";
  release?.();
  await vi.waitFor(() => expect(node("#notice").textContent).toContain("Snapshot temporarily unavailable"));
  expect(
    node("#notice").textContent,
    "An acknowledged creation must survive a failed Snapshot read",
  ).toContain(`${kind.label} ${kind.id} was created`);
  expect(node("#notice").textContent).toContain("Refresh explicitly");
  expect(node("#notice").textContent).toContain("Do not create it again");
  expect(control.disabled).toBe(false);
  expect(control.hasAttribute("data-pending")).toBe(false);
  expect(calls.filter((c) => c.method === "POST")).toEqual([
    {
      path: kind.path,
      method: "POST",
      body:
        kind.route === "accounts"
          ? { name: kind.name, provider: "fake", role_arn: "fake:demo-role" }
          : { name: kind.name },
    },
  ]);
  expect(data.plans).toEqual([oldPlan]);
  expect(data.operations).toEqual([]);
  expect(node(kind.route === "accounts" ? "#account-list" : "#network-list").textContent).not.toContain(
    kind.name,
  );
  node<HTMLButtonElement>("#refresh").click();
  await vi.waitFor(() => expect(node("#notice").textContent).toContain("Updated."));
  expect(node(kind.route === "accounts" ? "#account-list" : "#network-list").textContent).toContain(
    kind.name,
  );
  expect(node<HTMLSelectElement>("#network").value).toBe("original-network");
  if (kind.route === "accounts") {
    const row = [...document.querySelectorAll<HTMLLIElement>("#account-list li")].find(
      (li) => li.querySelector("strong")?.textContent === kind.name,
    );
    if (!row) throw new Error("Created account missing after explicit Refresh");
    row.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => expect(node<HTMLSelectElement>("#vpc").options).toHaveLength(2));
  }
  node<HTMLAnchorElement>('nav[aria-label="Workspace"] a[href="#/connections"]').click();
  await vi.waitFor(() => expect(node("#connect").hidden).toBe(false));
  const select = (id: string, value: string) => {
    node<HTMLSelectElement>(id).value = value;
    node(id).dispatchEvent(new Event("change"));
  };
  select("#vpc", kind.route === "accounts" ? "created-account-vpc" : "original-vpc");
  node<HTMLButtonElement>("#configure-connection").click();
  await vi.waitFor(() => expect(node("#connection-configure").hidden).toBe(false));
  select("#network", kind.route === "networks" ? kind.id : "original-network");
  expect(calls.filter((c) => c.path === "/api/v1/plans")).toEqual([]);
  submit("#plan-form");
  await vi.waitFor(() => expect(node("#plans").hidden).toBe(false));
  expect(generated?.request).toEqual({
    account_id: kind.route === "accounts" ? kind.id : "original-account",
    vpc_id: kind.route === "accounts" ? "created-account-vpc" : "original-vpc",
    subnet_ids: [kind.route === "accounts" ? "created-account-subnet" : "original-subnet"],
    network_id: kind.route === "networks" ? kind.id : "original-network",
    allow_application_traffic: false,
  });
  expect(JSON.parse(node("#plan-list article details pre").textContent ?? "null")).toEqual(generated);
  expect(data.plans.find((p) => p.id === oldPlan.id)).toEqual(oldPlan);
  expect(data.operations).toEqual([]);
  expect(calls.filter((c) => c.path === kind.path)).toHaveLength(1);
}

for (const kind of cases) {
  it(`serializes pending ${kind.route} creation through failed followup read and explicit guided recovery`, async () =>
    journey(kind, true));
  it(`retains acknowledged ${kind.route} identity after failed followup read and explicit guided recovery`, async () =>
    journey(kind, false));
}

// Supplementary client lifecycle qualification; the complete first GREEN above stays unchanged.
for (const kind of cases) {
  it(`keeps newer ${kind.route} creation owned across retired POST and Snapshot completions`, async () => {
    for (const phase of ["post", "snapshot"] as const) {
      for (const retirement of ["navigation", "refresh", "relogin"] as const) {
        document.querySelector<HTMLButtonElement>("#logout")?.click();
        vi.resetModules();
        document.body.innerHTML = '<div id="app"></div>';
        window.history.replaceState(null, "", `#/${kind.route}`);
        const data = initial();
        const calls: { path: string; method: string }[] = [];
        const posts: { resolve: (value: Response) => void; reject: (reason: Error) => void }[] = [];
        let releaseSnapshot: ((value: Response) => void) | undefined;
        let snapshots = 0;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input),
              method = init?.method ?? "GET";
            calls.push({ path, method });
            if (path === "/api/v1/snapshot") {
              snapshots++;
              if (phase === "snapshot" && snapshots === 2)
                return new Promise<Response>((resolve) => {
                  releaseSnapshot = resolve;
                });
              return new Response(JSON.stringify(data));
            }
            if (path === kind.path && method === "POST")
              return new Promise<Response>((resolve, reject) => {
                posts.push({ resolve, reject });
              });
            throw new Error(`Unexpected lifecycle request ${method} ${path}`);
          }),
        );
        await import("./main");
        const login = async () => {
          node<HTMLInputElement>("#token").value = "fixture-admin";
          submit("#login");
          await vi.waitFor(() => expect(node(`#${kind.route}`).hidden).toBe(false));
        };
        await login();
        const form = node<HTMLFormElement>(kind.form),
          control = node<HTMLButtonElement>(`${kind.form} button`);
        node<HTMLInputElement>(kind.input).value = kind.name;
        submit(kind.form);
        await vi.waitFor(() => expect(posts).toHaveLength(1));
        if (phase === "snapshot") {
          posts[0].resolve(new Response(JSON.stringify({ id: "older-acknowledged-record" })));
          await vi.waitFor(() => expect(releaseSnapshot).toBeTypeOf("function"));
          submit(kind.form);
          expect(posts).toHaveLength(1);
          expect(control.disabled).toBe(true);
        }
        if (retirement === "refresh") {
          node<HTMLButtonElement>("#refresh").click();
          await vi.waitFor(() => expect(node("#notice").textContent).toContain("Updated."));
        } else if (retirement === "relogin") {
          node<HTMLButtonElement>("#logout").click();
          await login();
        } else {
          node<HTMLAnchorElement>('nav[aria-label="Workspace"] a[href="#/overview"]').click();
          await vi.waitFor(() => expect(node("#overview").hidden).toBe(false));
          node<HTMLAnchorElement>(`nav[aria-label="Workspace"] a[href="#/${kind.route}"]`).click();
          await vi.waitFor(() => expect(node(`#${kind.route}`).hidden).toBe(false));
        }
        submit(kind.form);
        await vi.waitFor(() => expect(posts).toHaveLength(2));
        const before = calls.length;
        if (phase === "snapshot") {
          const retired = structuredClone(data);
          retired.networks[0].name = "Retired snapshot must not publish";
          releaseSnapshot?.(new Response(JSON.stringify(retired)));
        } else if (retirement === "refresh") {
          posts[0].resolve(new Response(JSON.stringify({ id: "older-success-must-not-read" })));
        } else posts[0].reject(new Error("Older request failed after retirement"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toHaveLength(before);
        expect(control.disabled).toBe(true);
        expect(control.hasAttribute("data-pending")).toBe(true);
        expect(node("#notice").textContent).toBe("Working…");
        expect(node("#network-list").textContent).not.toContain("Retired snapshot must not publish");
        submit(kind.form);
        expect(posts).toHaveLength(2);
        posts[1].resolve(new Response(JSON.stringify({ id: "new-current-created-record" })));
        await vi.waitFor(() => expect(node("#notice").textContent).toContain("Updated."));
        expect(control.disabled).toBe(false);
        expect(control.hasAttribute("data-pending")).toBe(false);
        expect(form.isConnected).toBe(true);
        expect(data.plans).toEqual(initial().plans);
        expect(data.operations).toEqual([]);
      }
    }
  });
  it(`refuses read-only ${kind.route} submits and permits explicit retry after a rejected POST`, async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, "", `#/${kind.route}`);
    const data = initial(),
      calls: string[] = [];
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/v1/snapshot") return new Response(JSON.stringify(data));
        if (path === kind.path && init?.method === "POST") {
          calls.push(path);
          if (fail)
            return new Response(JSON.stringify({ error: "Creation request rejected" }), { status: 400 });
          return new Response(JSON.stringify({ id: "explicit-retry-created-record" }));
        }
        throw new Error(`Unexpected role/retry request ${path}`);
      }),
    );
    await import("./main");
    const login = async () => {
      node<HTMLInputElement>("#token").value = "fixture-role";
      submit("#login");
      await vi.waitFor(() => expect(node(`#${kind.route}`).hidden).toBe(false));
    };
    data.role = "read_only";
    await login();
    const control = node<HTMLButtonElement>(`${kind.form} button`);
    expect(control.disabled).toBe(true);
    const notice = node("#notice").textContent;
    control.disabled = false;
    submit(kind.form);
    expect(calls).toEqual([]);
    expect(node("#notice").textContent).toBe(notice);
    node<HTMLButtonElement>("#logout").click();
    data.role = "admin";
    await login();
    submit(kind.form);
    await vi.waitFor(() => expect(node("#notice").textContent).toBe("Creation request rejected"));
    expect(node("#notice").textContent).not.toContain("was created");
    expect(control.disabled).toBe(false);
    fail = false;
    submit(kind.form);
    await vi.waitFor(() => expect(node("#notice").textContent).toContain("Updated."));
    expect(calls).toEqual([kind.path, kind.path]);
    expect(data.plans).toEqual(initial().plans);
    expect(data.operations).toEqual([]);
  });
}

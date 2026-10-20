import { afterEach, expect, it, vi } from "vitest";
import type { Snapshot, TgwLookupResponse, TopologyView, VerifiedAccount } from "./generated";

// Deferred credential-free HTTP responses through the real main.ts/session/renderer integration.
// Fetch intentionally ignores abort so generation/account checks must still protect the view.
const account = (id: string): VerifiedAccount => ({
  id,
  name: `Fixture ${id}`,
  role_arn: "arn:aws:iam::123456789012:role/Reader",
  aws_account_id: "123456789012",
  region: "eu-west-1",
  verified_at: "1",
  verified_session_name: "fixture",
  execution_enabled: false,
});
const snapshot: Snapshot = {
  accounts: [],
  inventory: [],
  networks: [],
  plans: [],
  operations: [],
  mode: "demo",
  role: "read_only",
  aws_accounts: [account("account-a"), account("account-b")],
  aws_read_only_enabled: false,
  aws_regions: [],
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function topology(id: string): TopologyView {
  return {
    topology: {
      id: `snapshot-${id}`,
      account_id: id,
      aws_account_id: "123456789012",
      region: "eu-west-1",
      started_at: "1",
      completed_at: "2",
      session_name: "fixture",
      request_ids: [],
      complete_for_supported_queries: true,
      limitations: [],
      execution_enabled: false,
      connectivity_tested: false,
      resources: [
        {
          kind: "transit_gateway_route_table",
          id: `table-${id}`,
          owner_account_id: null,
          vpc_id: null,
          subnet_id: null,
          az_id: null,
          state: "available",
          cidrs: [],
          public_ips: [],
          private_ips: [],
          tags: {},
          routes: [],
          associations: [],
          tgw_associations: null,
          tgw_propagations: null,
          tgw_routes: null,
          related_ids: [],
          connectivity_type: null,
          availability_mode: null,
          managed: false,
        },
      ],
    },
    adoptions: [],
    subnet_route_tables: [],
  };
}
const lookup: TgwLookupResponse = {
  topology_id: "snapshot-account-a",
  route_table_id: "table-account-a",
  destination: "203.0.113.1",
  result: {
    status: "reported_forward",
    destination_cidr: "0.0.0.0/0",
    route_type: "static",
    attachment_ids: ["old-lookup-attachment"],
  },
  execution_enabled: false,
  connectivity_tested: false,
};
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function boot(handler: (path: string) => Promise<Response>) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      return path === "/api/v1/snapshot" ? Promise.resolve(response(snapshot)) : handler(path);
    }),
  );
  await import("./main");
  const token = document.querySelector<HTMLInputElement>("#token");
  if (!token) throw new Error("Login input missing");
  token.value = "fixture-reader";
  document.querySelector("#login")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(document.querySelectorAll("#aws-account-list li")).toHaveLength(2));
}
function select(id: string) {
  const row = [...document.querySelectorAll("#aws-account-list li")].find((node) =>
    node.textContent?.includes(`Fixture ${id}`),
  );
  const button = row?.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("Saved account control missing");
  button.click();
}
function startLookup() {
  const form = document.querySelector<HTMLFormElement>("#aws-topology form[data-route-lookup]");
  const input = form?.querySelector<HTMLInputElement>("input");
  if (!form || !input) throw new Error("Saved lookup input missing");
  input.value = "203.0.113.1";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it("late account topology cannot replace a newer selected account", async () => {
  const old = deferred();
  await boot(async (path) => (path.includes("account-a") ? old.promise : response(topology("account-b"))));
  select("account-a");
  select("account-b");
  await vi.waitFor(() =>
    expect(document.querySelector("#aws-topology")?.textContent).toContain("table-account-b"),
  );
  old.resolve(response(topology("account-a")));
  await new Promise((done) => setTimeout(done, 10));
  expect(document.querySelector("#aws-topology")?.textContent).toContain("table-account-b");
  expect(document.querySelector("#aws-topology")?.textContent).not.toContain("table-account-a");
});
it("late saved lookup cannot enter another account view", async () => {
  const old = deferred();
  await boot(async (path) =>
    path.includes("tgw-route-lookup")
      ? old.promise
      : response(topology(path.includes("account-a") ? "account-a" : "account-b")),
  );
  select("account-a");
  await vi.waitFor(() => expect(document.querySelector("form[data-route-lookup]")).not.toBeNull());
  startLookup();
  select("account-b");
  await vi.waitFor(() =>
    expect(document.querySelector("#aws-topology")?.textContent).toContain("table-account-b"),
  );
  old.resolve(response(lookup));
  await new Promise((done) => setTimeout(done, 10));
  expect(document.querySelector("#aws-topology")?.textContent).not.toContain("old-lookup-attachment");
});
it("logout clears saved lookup and discards its response even when fetch ignores abort", async () => {
  const old = deferred();
  await boot(async (path) =>
    path.includes("tgw-route-lookup") ? old.promise : response(topology("account-a")),
  );
  select("account-a");
  await vi.waitFor(() => expect(document.querySelector("form[data-route-lookup]")).not.toBeNull());
  startLookup();
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  old.resolve(response(lookup));
  await new Promise((done) => setTimeout(done, 10));
  expect(document.querySelector("#aws-topology")?.childElementCount).toBe(0);
  expect(document.querySelector("#identity")?.textContent).toBe("Signed out");
  expect(document.querySelector<HTMLElement>("#workspace")?.hidden).toBe(true);
});

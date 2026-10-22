import { afterEach, expect, it } from "vitest";
import type { AwsResource, AwsTopology } from "./generated";
import { renderSavedAwsWorkspace } from "./saved-aws-workspace";

const record = (id: string, kind: AwsResource["kind"] = "vpc"): AwsResource => ({
  kind,
  id,
  owner_account_id: "foreign-literal",
  vpc_id: null,
  subnet_id: null,
  az_id: null,
  state: null,
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
  nat_gateway: null,
  managed: false,
});
const capture = (resources = [record("vpc-a")]): AwsTopology => ({
  id: "saved-capture",
  account_id: "registration",
  aws_account_id: "210987654321",
  region: "eu-west-1",
  started_at: "old-start",
  completed_at: "original-completed",
  session_name: "fixture",
  resources,
  request_ids: [],
  complete_for_supported_queries: true,
  limitations: [],
  execution_enabled: false,
  connectivity_tested: false,
});
function mount(data = capture(), current = () => true) {
  const root = renderSavedAwsWorkspace(data, current);
  document.body.append(root);
  return root;
}
function select(root: HTMLElement, kind: string) {
  const node = root.querySelector<HTMLSelectElement>("select");
  if (!node) throw new Error("Kind selector missing");
  node.value = kind;
  node.dispatchEvent(new Event("change"));
}
function choose(root: HTMLElement, index: number) {
  const node = root.querySelector<HTMLButtonElement>(`[data-record-index="${index}"]`);
  if (!node) throw new Error("Original index missing");
  node.click();
}
function original(root: HTMLElement) {
  const details = root.querySelector<HTMLDetailsElement>("aside details");
  if (!details) throw new Error("Original metadata missing");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  return JSON.parse(details.querySelector("pre")?.textContent ?? "null");
}
afterEach(() => document.body.replaceChildren());

it("binds original record inspection to one saved capture and preserves complete failed/unknown metadata", () => {
  const nat = record("nat-a", "nat_gateway");
  nat.state = "failed";
  nat.vpc_id = "unvalidated-vpc-literal";
  nat.nat_gateway = {
    route_table_id: "unvalidated-reference",
    addresses: [
      {
        allocation_id: null,
        association_id: null,
        network_interface_id: null,
        public_ip: "203.0.113.9",
        private_ip: null,
        az_name: "name-only-zone",
        az_id: null,
        is_primary: null,
        status: "future-failed-status",
      },
    ],
  };
  const data = capture([nat]),
    before = structuredClone(data);
  const root = mount(data);
  expect(root.dataset.topologyId).toBe(data.id);
  expect(root.dataset.completedAt).toBe(data.completed_at);
  expect(root.querySelector("pre")).toBeNull();
  expect(original(root)).toEqual(nat);
  expect(root.textContent).toContain("foreign-literal");
  expect(root.textContent).toContain("Reported metadata is not health or a usable path");
  expect(root.querySelectorAll("path,form,a")).toHaveLength(0);
  expect(data).toEqual(before);
});

it("keeps duplicate identities across kinds as separate original indexes without preferring one", () => {
  const a = record("same", "vpc"),
    b = record("same", "nat_gateway");
  b.state = "available";
  const root = mount(capture([a, b]));
  choose(root, 1);
  expect(original(root)).toEqual(b);
  expect(root.querySelector("aside")?.textContent).toContain("not unique across captured records");
  select(root, "vpc");
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(1);
  expect(original(root)).toEqual(a);
  expect(root.querySelector("aside")?.textContent).toContain("not unique across captured records");
});

it("rejects invalid identity/disabled markers and malformed later accessed rows before any prefix", () => {
  const cases: AwsTopology[] = [];
  for (const field of ["execution_enabled", "connectivity_tested"] as const)
    for (const value of [undefined, null, 0, true]) {
      const item = capture();
      item[field] = value as unknown as boolean;
      cases.push(item);
    }
  const sparse = capture();
  sparse.resources = Array(25) as AwsResource[];
  cases.push(sparse);
  const badTail = capture([record("good"), record("bad")]);
  badTail.resources[1].public_ips = [7] as unknown as string[];
  cases.push(badTail);
  const missingTime = capture();
  missingTime.completed_at = "";
  cases.push(missingTime);
  const wrongKind = capture();
  wrongKind.resources[0].kind = "future-kind" as AwsResource["kind"];
  cases.push(wrongKind);
  for (const item of cases) {
    const root = mount(item);
    expect(root.textContent).toContain("map unavailable");
    expect(root.querySelectorAll("[data-record-index]")).toHaveLength(0);
  }
});

it("retains incomplete scans, empty results, null and empty reported strings without absence inference", () => {
  const data = capture([]);
  data.complete_for_supported_queries = false;
  const empty = mount(data);
  expect(empty.textContent).toContain("supported-query scan incomplete");
  expect(empty.textContent).toContain("No resource absence is inferred");
  const r = record("literal");
  r.state = "";
  r.public_ips = [""];
  const root = mount(capture([r]));
  expect(root.textContent).toContain("Empty reported value");
  expect(root.textContent).toContain("Not reported");
  expect(original(root)).toEqual(r);
});

it("reveals all filtered records in bounded batches with original full-capture indexes", () => {
  const data = capture([
    record("vpc-first"),
    ...Array.from({ length: 52 }, (_, i) => record(`nat-${i}`, "nat_gateway")),
  ]);
  const root = mount(data);
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(24);
  const oldMore = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Show more captured records",
  );
  if (!oldMore) throw new Error("Continuation missing");
  oldMore.click();
  oldMore.click();
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(48);
  select(root, "nat_gateway");
  expect(root.querySelector('[aria-pressed="true"]')?.getAttribute("data-record-index")).toBe("1");
  const more = () =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Show more captured records",
    );
  more()?.click();
  more()?.click();
  const indexes = [...root.querySelectorAll<HTMLElement>("[data-record-index]")].map((n) =>
    Number(n.dataset.recordIndex),
  );
  expect(indexes).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
  choose(root, 52);
  expect(original(root)).toEqual(data.resources[52]);
  select(root, "all");
  expect(root.querySelector('[aria-pressed="true"]')?.getAttribute("data-record-index")).toBe("0");
});

it("retires old selectors, nodes, continuation and lazy metadata on local redraw or owner retirement", () => {
  let current = true;
  const root = mount(capture([record("vpc"), record("nat", "nat_gateway")]), () => current);
  const oldSelect = root.querySelector<HTMLSelectElement>("select");
  const oldNode = root.querySelector<HTMLButtonElement>('[data-record-index="0"]');
  const oldDetails = root.querySelector<HTMLDetailsElement>("aside details");
  choose(root, 1);
  if (oldSelect) {
    oldSelect.value = "vpc";
    oldSelect.dispatchEvent(new Event("change"));
  }
  oldNode?.click();
  if (oldDetails) {
    oldDetails.open = true;
    oldDetails.dispatchEvent(new Event("toggle"));
  }
  expect(root.querySelector("aside h4")?.textContent).toContain("nat");
  expect(oldDetails?.querySelector("pre")).toBeNull();
  current = false;
  choose(root, 0);
  expect(root.querySelector("aside h4")?.textContent).toContain("nat");
  root.remove();
  oldNode?.click();
  expect(oldDetails?.querySelector("pre")).toBeNull();
});

it("renders provider-controlled names, statuses and reference literals as inert text", () => {
  const r = record("<img src=x>", "nat_gateway");
  r.tags.Name = "<script>bad()</script>";
  r.state = "future-<img src=x>";
  const root = mount(capture([r]));
  expect(root.textContent).toContain(r.tags.Name);
  expect(root.textContent).toContain(r.state);
  expect(root.querySelectorAll("img,script")).toHaveLength(0);
  expect(original(root)).toEqual(r);
});

function filterText(root: HTMLElement, value: string) {
  const input = root.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("Saved literal filter missing");
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

it("filters only literal ID or own Name while preserving original identity and whole-capture ambiguity", () => {
  const a = record("same-ID"),
    b = record("same-ID", "nat_gateway");
  a.tags.Name = "Name <img src=x> é";
  b.state = "failed";
  const data = capture([a, b, record(" space ")]),
    before = structuredClone(data);
  const root = mount(data);
  filterText(root, "<img src=x> é");
  expect(
    [...root.querySelectorAll<HTMLElement>("[data-record-index]")].map((n) => n.dataset.recordIndex),
  ).toEqual(["0"]);
  expect(original(root)).toEqual(a);
  expect(root.querySelector("aside")?.textContent).toContain("not unique across captured records");
  expect(root.querySelector("img")).toBeNull();
  filterText(root, "name");
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(0);
  expect(root.querySelector("aside pre")).toBeNull();
  expect(root.textContent).toContain("No resource absence is inferred");
  filterText(root, "same-ID");
  select(root, "nat_gateway");
  expect(original(root)).toEqual(b);
  expect(root.querySelector("aside")?.textContent).toContain("not unique across captured records");
  select(root, "all");
  filterText(root, " space ");
  expect(original(root)).toEqual(data.resources[2]);
  filterText(root, "  space  ");
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(0);
  filterText(root, "");
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(3);
  expect(data).toEqual(before);
});

it("resets continuation and visible selection on each text or kind change without dropping matching rows", () => {
  const data = capture([
    record("vpc"),
    ...Array.from({ length: 52 }, (_, i) => record(`nat-${i}`, "nat_gateway")),
  ]);
  const root = mount(data);
  const more = () =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Show more captured records",
    );
  filterText(root, "nat-");
  more()?.click();
  more()?.click();
  expect(
    [...root.querySelectorAll<HTMLElement>("[data-record-index]")].map((n) => Number(n.dataset.recordIndex)),
  ).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
  choose(root, 52);
  expect(original(root)).toEqual(data.resources[52]);
  filterText(root, "nat-5");
  expect(
    [...root.querySelectorAll<HTMLElement>("[data-record-index]")].map((n) => n.dataset.recordIndex),
  ).toEqual(["6", "51", "52"]);
  expect(root.querySelector('[aria-pressed="true"]')?.getAttribute("data-record-index")).toBe("6");
  filterText(root, "nat-");
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(24);
  select(root, "vpc");
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(0);
  filterText(root, "");
  expect(original(root)).toEqual(data.resources[0]);
});

it("retains typing focus and selection while retiring earlier controls and lazy records", () => {
  let current = true;
  const root = mount(
    capture([record("vpc"), ...Array.from({ length: 52 }, (_, i) => record(`nat-${i}`, "nat_gateway"))]),
    () => current,
  );
  const oldSearch = root.querySelector<HTMLInputElement>('input[type="search"]');
  const oldSelect = root.querySelector<HTMLSelectElement>("select");
  const oldNode = root.querySelector<HTMLButtonElement>('[data-record-index="0"]');
  const oldDetails = root.querySelector<HTMLDetailsElement>("aside details");
  const oldMore = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Show more captured records",
  );
  if (!oldSearch) throw new Error("Search missing");
  oldSearch.value = "nat-";
  oldSearch.setSelectionRange(1, 3);
  oldSearch.dispatchEvent(new Event("input"));
  const live = root.querySelector<HTMLInputElement>('input[type="search"]');
  expect(document.activeElement).toBe(live);
  expect([live?.selectionStart, live?.selectionEnd]).toEqual([1, 3]);
  oldSearch.value = "vpc";
  oldSearch.dispatchEvent(new Event("input"));
  if (oldSelect) {
    oldSelect.value = "vpc";
    oldSelect.dispatchEvent(new Event("change"));
  }
  oldNode?.click();
  oldMore?.click();
  if (oldDetails) {
    oldDetails.open = true;
    oldDetails.dispatchEvent(new Event("toggle"));
  }
  expect(oldDetails?.querySelector("pre")).toBeNull();
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(24);
  expect(original(root).id).toBe("nat-0");
  current = false;
  filterText(root, "vpc");
  expect(root.querySelector("aside h4")?.textContent).toContain("nat-0");
  root.remove();
  current = true;
  filterText(root, "");
  expect(root.querySelectorAll("[data-record-index]")).toHaveLength(24);
  expect(root.querySelector("aside h4")?.textContent).toContain("nat-0");
});

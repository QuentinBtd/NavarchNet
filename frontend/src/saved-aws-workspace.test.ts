import { afterEach, expect, it } from "vitest";
import type { AwsResource, AwsTopology } from "./generated";
import { renderNatMetadata } from "./nat-metadata-view";
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

function tupleNat(): AwsResource {
  const nat = record("nat-<img src=x>", "nat_gateway");
  nat.nat_gateway = {
    route_table_id: "unvalidated-table",
    addresses: Array.from({ length: 101 }, (_, i) => ({
      allocation_id: null,
      association_id: null,
      network_interface_id: null,
      public_ip: "203.0.113.9",
      private_ip: "",
      az_name: "account-specific-name",
      az_id: null,
      is_primary: i === 0 ? true : i === 1 ? false : null,
      status: i === 0 ? "succeeded" : i === 1 ? "failed" : "future-<img src=x>",
    })),
  };
  return nat;
}
function openNat(detail: HTMLDetailsElement) {
  detail.open = true;
  detail.dispatchEvent(new Event("toggle"));
}

it("rejects sparse and inherited NAT tuple tails before a valid-looking first batch", () => {
  for (const inherited of [false, true]) {
    const nat = tupleNat(),
      addresses = nat.nat_gateway?.addresses;
    if (!addresses) throw new Error("Fixture missing");
    const item = addresses[80];
    delete addresses[80];
    if (inherited) {
      const proto = Object.create(Array.prototype);
      proto[80] = item;
      Object.setPrototypeOf(addresses, proto);
    }
    const detail = renderNatMetadata(nat, capture());
    document.body.append(detail);
    openNat(detail);
    expect(detail.querySelectorAll("[data-nat-address]")).toHaveLength(0);
    expect(detail.textContent).toContain("malformed; no address tuples displayed");
    expect(detail.querySelector("button[data-nat-more]")).toBeNull();
  }
});

it("saved-map NAT tuples are lazy capture-bound complete and retired with their original inspector", () => {
  const nat = tupleNat(),
    data = capture([nat, record("other")]),
    before = structuredClone(data),
    root = mount(data);
  const detail = root.querySelector<HTMLDetailsElement>("aside details[data-nat-metadata]");
  if (!detail) throw new Error("Contextual NAT metadata missing");
  expect(detail.querySelector("li")).toBeNull();
  expect(original(root)).toEqual(nat);
  openNat(detail);
  expect(detail.textContent).toContain("Saved snapshot: saved-capture · completed: original-completed");
  expect(detail.textContent).toContain("not selected egress IPs, not NAT health or a selected traffic AZ");
  const more = detail.querySelector<HTMLButtonElement>("button[data-nat-more]");
  if (!more) throw new Error("Continuation missing");
  expect(detail.querySelectorAll("li[data-nat-address]")).toHaveLength(50);
  choose(root, 1);
  more.click();
  expect(detail.querySelectorAll("li[data-nat-address]")).toHaveLength(50);
  expect(root.querySelector("aside [data-nat-metadata]")).toBeNull();
  choose(root, 0);
  const live = root.querySelector<HTMLDetailsElement>("aside details[data-nat-metadata]");
  if (!live) throw new Error("New inspector missing");
  openNat(live);
  const next = live.querySelector<HTMLButtonElement>("button[data-nat-more]");
  if (!next) throw new Error("New continuation missing");
  next.remove();
  next.click();
  expect(live.querySelectorAll("li[data-nat-address]")).toHaveLength(50);
  live.append(next);
  next.click();
  next.click();
  next.click();
  openNat(live);
  expect(live.querySelectorAll("li[data-nat-address]")).toHaveLength(101);
  expect(live.textContent).toContain("Reported primary: false");
  expect(live.textContent).toContain("future-<img src=x>");
  expect(live.querySelector("img,script,a,input,form")).toBeNull();
  expect(data).toEqual(before);
  choose(root, 1);
  choose(root, 0);
  const retired = root.querySelector<HTMLDetailsElement>("aside details[data-nat-metadata]");
  if (!retired) throw new Error("Unopened inspector missing");
  root.remove();
  openNat(retired);
  expect(retired.querySelector("li")).toBeNull();
  for (const [metadata, message] of [
    [null, "NAT details not captured"],
    [{ route_table_id: null, addresses: null }, "Address collection not reported"],
    [{ route_table_id: null, addresses: [] }, "Reported address tuples: 0"],
  ] as const) {
    const value = record("nat", "nat_gateway");
    value.nat_gateway = metadata as AwsResource["nat_gateway"];
    const node = mount(capture([value])).querySelector<HTMLDetailsElement>(
      "aside details[data-nat-metadata]",
    );
    if (!node) throw new Error("Unknown/empty metadata control missing");
    openNat(node);
    expect(node.textContent).toContain(message);
    expect(node.querySelector("li")).toBeNull();
  }
});

it("displays capture-bound returned subnet selections without inventing a route or choosing the first row", () => {
  const a = record(" subnet-<img src=x> ", "subnet"),
    b = record("other", "subnet"),
    c = record("unresolved", "subnet");
  for (const item of [a, b, c]) item.vpc_id = "literal-vpc";
  const data = capture([a, b, c]),
    before = structuredClone(data);
  const context: NonNullable<Parameters<typeof renderSavedAwsWorkspace>[2]> = {
    topology: data,
    subnet_route_tables: [
      {
        subnet_id: c.id,
        vpc_id: c.vpc_id,
        selection: { status: "unresolved", reason: "missing_route_table" },
      },
      {
        subnet_id: b.id,
        vpc_id: b.vpc_id,
        selection: { status: "selected", route_table_id: "main-table", source: "implicit_main" },
      },
      {
        subnet_id: a.id,
        vpc_id: a.vpc_id,
        selection: { status: "selected", route_table_id: "rtb-<img src=x>", source: "explicit_subnet" },
      },
    ],
  };
  let current = true;
  const root = renderSavedAwsWorkspace(data, () => current, context);
  document.body.append(root);
  const panel = () => root.querySelector("aside [data-captured-subnet-table]");
  expect(panel()?.textContent).toContain("Selected table: rtb-<img src=x>");
  expect(panel()?.textContent).toContain("Association source: explicit_subnet");
  expect(original(root)).toEqual(a);
  choose(root, 1);
  expect(panel()?.textContent).toContain("Selected table: main-table");
  expect(panel()?.textContent).toContain("Association source: implicit_main");
  choose(root, 2);
  expect(panel()?.textContent).toContain("Selection unresolved: missing_route_table");
  expect(panel()?.textContent).toContain(`Capture ${data.id} · completed ${data.completed_at}`);
  expect(panel()?.textContent).toContain("Not a destination-route decision, health check or verified path");
  current = false;
  choose(root, 0);
  root.remove();
  current = true;
  choose(root, 0);
  expect(panel()?.textContent).toContain("Selection unresolved: missing_route_table");
  expect(root.querySelector("img,script,form,a")).toBeNull();
  expect(data).toEqual(before);
});

it("keeps unavailable ambiguous or malformed subnet calculations unknown without hiding the original record", () => {
  // Typed callback contract negatives, not malformed public HTTP acceptance.
  const subnet = record("subnet", "subnet");
  subnet.vpc_id = "vpc";
  const data = capture([subnet]);
  type Context = NonNullable<Parameters<typeof renderSavedAwsWorkspace>[2]>;
  const row: Context["subnet_route_tables"][number] = {
    subnet_id: "subnet",
    vpc_id: "vpc",
    selection: { status: "selected", route_table_id: "must-not-display", source: "implicit_main" },
  };
  const context: Context = { topology: data, subnet_route_tables: [row] };
  const cases: (Context | undefined)[] = [
    undefined,
    { ...context, topology: structuredClone(data) },
    { ...context, subnet_route_tables: [] },
    { ...context, subnet_route_tables: [row, structuredClone(row)] },
    { ...context, subnet_route_tables: [{ ...row, vpc_id: "different-vpc" }] },
    { ...context, subnet_route_tables: [{ ...row, subnet_id: " subnet " }] },
    {
      ...context,
      subnet_route_tables: [
        { ...row, selection: { status: "selected", route_table_id: "bad", source: "future" as never } },
      ],
    },
  ];
  for (const inherited of [false, true]) {
    const rows = Array.from({ length: 61 }, (_, i) => (i === 0 ? row : { ...row, subnet_id: `other-${i}` }));
    const item = rows[50];
    delete rows[50];
    if (inherited) {
      const proto = Object.create(Array.prototype);
      proto[50] = item;
      Object.setPrototypeOf(rows, proto);
    }
    cases.push({ ...context, subnet_route_tables: rows });
  }
  const tail = Array.from({ length: 61 }, (_, i) => (i === 0 ? row : { ...row, subnet_id: `other-${i}` }));
  tail[60] = {
    ...row,
    subnet_id: "bad",
    selection: { status: "selected", route_table_id: null as unknown as string, source: "implicit_main" },
  };
  cases.push({ ...context, subnet_route_tables: tail });
  for (const candidate of cases) {
    const root = renderSavedAwsWorkspace(data, () => true, candidate);
    document.body.append(root);
    const panel = root.querySelector("aside [data-captured-subnet-table]");
    expect(panel?.textContent).toContain("unavailable or ambiguous");
    expect(panel?.textContent).not.toContain("Selected table:");
    expect(original(root)).toEqual(subnet);
  }
  for (const kind of ["subnet", "nat_gateway"] as const) {
    const duplicate = capture([subnet, record(subnet.id, kind)]);
    const root = renderSavedAwsWorkspace(duplicate, () => true, { ...context, topology: duplicate });
    document.body.append(root);
    expect(root.querySelector("aside [data-captured-subnet-table]")?.textContent).toContain(
      "unavailable or ambiguous",
    );
  }
});

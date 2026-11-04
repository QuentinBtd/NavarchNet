import { afterEach, expect, it, vi } from "vitest";
import type { Plan, Snapshot } from "./generated";
import { planHistorySearch } from "./plan-history-search";
import { renderPlanReview } from "./plan-review-view";

const plan = (id: string, vpc = "vpc-app"): Plan => ({
  id,
  scope: `account/${vpc}`,
  scope_version: 1,
  inventory_revision: 2,
  network_revision: 3,
  digest: `digest-${id}`,
  request: {
    account_id: "account",
    vpc_id: vpc,
    network_id: "network",
    subnet_ids: ["subnet"],
    allow_application_traffic: false,
  },
  actions: [{ kind: "attachment", target: vpc, requires: [], postcondition: "simulated available" }],
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("./plan-review-view");
});

it("filters only returned plan choices without replacing original selected evidence or applying", () => {
  const plans = [plan("newer"), plan("older", "vpc-old")],
    before = structuredClone(plans),
    onSelect = vi.fn(),
    makeApply = vi.fn(() => document.createElement("button"));
  const root = renderPlanReview(plans, {
    selectedPlanId: "newer",
    isCurrent: () => true,
    onSelect,
    makeApply,
  });
  document.body.append(root);
  const input = root.querySelector<HTMLInputElement>('input[type="search"]');
  expect(input).not.toBeNull();
  if (!input) throw new Error("Missing plan history search");
  input.value = "vpc-old";
  input.dispatchEvent(new Event("input"));
  expect([...root.querySelectorAll<HTMLOptionElement>("select option")].map((o) => o.value)).toEqual([
    "older",
  ]);
  expect(root.querySelector("article")?.dataset.planId).toBe("newer");
  expect(root.textContent).toContain(
    "Selected plan is outside search results; its original detail is unchanged.",
  );
  expect(JSON.parse(root.querySelector("article details pre")?.textContent ?? "null")).toEqual(plans[0]);
  expect(onSelect).not.toHaveBeenCalled();
  expect(makeApply).toHaveBeenCalledTimes(1);
  const select = root.querySelector<HTMLSelectElement>("select");
  if (!select) throw new Error("Missing plan picker");
  expect(select.value).toBe("");
  select.value = "older";
  select.dispatchEvent(new Event("change"));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("older");
  expect(plans).toEqual(before);
});

it("validates every original nested search field and preserves literal order, caps and retired-control refusal", () => {
  const mount = (plans: Plan[]) => {
    const root = document.createElement("div"),
      select = document.createElement("select"),
      state = { query: "" };
    for (let i = 0; i < plans.length; i++) {
      const option = document.createElement("option");
      option.value = plans[i]?.id ?? String(i);
      select.append(option);
    }
    root.append(select);
    let current = true;
    const search = planHistorySearch(root, select, plans, plans[0]?.id, () => current, state);
    root.prepend(search.controls);
    document.body.append(root);
    const input = root.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing search");
    return {
      root,
      select,
      input,
      state,
      search,
      query: (value: string) => {
        input.value = value;
        input.dispatchEvent(new Event("input"));
      },
      retire: () => {
        current = false;
      },
    };
  };
  const literal = plan(" +%é <script> ", "VPC EXACT"),
    other = plan("other");
  literal.request.account_id = "Original account";
  literal.request.network_id = "Original network";
  literal.actions[0] = {
    kind: "nat_route",
    target: "not-searched",
    requires: [],
    postcondition: "not-searched",
  };
  const rows = [literal, other],
    first = mount(rows);
  for (const term of [
    " +%é ",
    "Original account",
    "Original network",
    "VPC EXACT",
    "account/VPC",
    "vpc exact",
    "not-searched",
    "",
  ]) {
    first.query(term);
    const expected = rows.filter((row) =>
      [row.id, row.scope, row.request.account_id, row.request.vpc_id, row.request.network_id].some((value) =>
        value.includes(term),
      ),
    );
    expect([...first.select.options].map((option) => option.value)).toEqual(expected.map((row) => row.id));
    expect(first.state.query).toBe(term);
  }
  expect(first.root.querySelector("script")).toBeNull();
  first.query("x".repeat(257));
  expect(first.select.options).toHaveLength(0);
  expect(first.select.disabled).toBe(true);
  expect(first.root.textContent).toContain("Plan search unavailable");
  first.query("");
  expect(first.select.options).toHaveLength(2);
  first.input.disabled = true;
  first.query("other");
  expect(first.state.query).toBe("");
  first.input.disabled = false;
  first.root.append(first.input);
  first.query("other");
  expect(first.state.query).toBe("");
  first.search.controls.append(first.input);
  first.select.remove();
  first.query("other");
  expect(first.state.query).toBe("");
  first.root.append(first.select);
  first.retire();
  first.query("other");
  expect(first.state.query).toBe("");
  const many = mount(Array.from({ length: 1000 }, (_, i) => plan(`id-${i}`)));
  many.query("id-999");
  expect([...many.select.options].map((option) => option.value)).toEqual(["id-999"]);
  many.query("x".repeat(256));
  expect(many.root.textContent).toContain("0 of 1000 returned plans match");
  const sparse = [plan("prefix"), plan("tail")];
  delete sparse[1];
  const inherited = [plan("prefix"), plan("tail")];
  delete inherited[1];
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 1: plan("tail") }));
  const inheritedField = plan("tail");
  delete (inheritedField.request as Partial<Plan["request"]>).account_id;
  Object.setPrototypeOf(inheritedField.request, { account_id: "inherited" });
  for (const values of [
    sparse,
    inherited,
    [plan("prefix"), inheritedField],
    [plan("duplicate"), plan("duplicate")],
    [{ ...plan("over"), scope: "x".repeat(16385) }],
    Array.from({ length: 1001 }, (_, i) => plan(String(i))),
    Array.from({ length: 33 }, (_, i) => ({
      ...plan(String(i)),
      scope: "x".repeat(16384),
      request: { ...plan(String(i)).request, network_id: "y".repeat(16384) },
    })),
  ]) {
    const rejected = mount(values);
    expect(rejected.select.options).toHaveLength(0);
    expect(rejected.select.disabled).toBe(true);
    expect(rejected.root.textContent).toContain("Plan search unavailable");
    expect(rejected.search.canSelect(values[0]?.id ?? "")).toBe(false);
  }
  for (const change of [
    (values: Plan[]) => {
      const row = values[1];
      if (!row) throw new Error("Missing tail");
      values[1] = { ...row };
    },
    (values: Plan[]) => {
      const row = values[1];
      if (!row) throw new Error("Missing tail");
      row.request = { ...row.request };
    },
    (values: Plan[]) => {
      const row = values[1];
      if (!row) throw new Error("Missing tail");
      row.request.network_id = "changed";
    },
    (values: Plan[]) => {
      values.push(plan("prefix"));
    },
  ]) {
    const values = [plan("prefix"), plan("tail")],
      changed = mount(values);
    change(values);
    expect(changed.search.canSelect("prefix")).toBe(false);
    changed.query("prefix");
    expect(changed.select.options).toHaveLength(0);
  }
  const detached = mount([plan("a")]);
  detached.root.remove();
  detached.query("a");
  expect(detached.state.query).toBe("");
  const onSelect = vi.fn(),
    rendered = renderPlanReview([plan("a"), plan("b")], {
      isCurrent: () => true,
      onSelect,
      makeApply: () => document.createElement("button"),
    });
  document.body.append(rendered);
  const input = rendered.querySelector<HTMLInputElement>("input"),
    select = rendered.querySelector<HTMLSelectElement>("select");
  if (!input || !select) throw new Error("Missing controls");
  input.value = "no-match";
  input.dispatchEvent(new Event("input"));
  select.disabled = false;
  const option = document.createElement("option");
  option.value = "a";
  select.append(option);
  select.value = "a";
  select.dispatchEvent(new Event("change"));
  expect(onSelect).not.toHaveBeenCalled();
});

it("binds the parent search to its original returned plan array and retains query only within the current session", async () => {
  vi.resetModules();
  let captured: { plans: Plan[]; options: Parameters<typeof renderPlanReview>[1] } | undefined;
  vi.doMock("./plan-review-view", async () => {
    const real = await vi.importActual<typeof import("./plan-review-view")>("./plan-review-view");
    return {
      ...real,
      renderPlanReview: (plans: Plan[], options: Parameters<typeof renderPlanReview>[1]) => {
        captured = { plans, options };
        return real.renderPlanReview(plans, options);
      },
    };
  });
  const snapshot: Snapshot = {
    accounts: [],
    inventory: [],
    networks: [],
    plans: [plan("newer"), plan("older", "vpc-old")],
    operations: [],
    mode: "demo",
    role: "read_only",
    aws_accounts: [],
    aws_regions: [],
    aws_read_only_enabled: false,
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/v1/snapshot") return new Response(JSON.stringify(snapshot));
    throw new Error(`Unexpected request ${String(input)}`);
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
  const search = () => {
    const input = document.querySelector<HTMLInputElement>("#plan-history-search");
    if (!input) throw new Error("Missing search");
    return input;
  };
  const query = (value: string) => {
    search().value = value;
    search().dispatchEvent(new Event("input"));
  };
  const click = (id: string) => document.querySelector<HTMLButtonElement>(id)?.click();
  await login();
  const original = captured;
  if (!original?.options.currentSnapshot || !original.options.searchState)
    throw new Error("Missing captured parent source");
  const retained = search(),
    calls = fetcher.mock.calls.length;
  original.options.currentSnapshot.plans = original.plans.slice();
  retained.value = "older";
  retained.dispatchEvent(new Event("input"));
  expect(original.options.searchState.query).toBe("");
  expect(original.options.isCurrent()).toBe(false);
  original.options.onSelect("older");
  expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("newer");
  expect(fetcher.mock.calls.length).toBe(calls);
  click("#refresh");
  await vi.waitFor(() => expect(search()).not.toBe(retained));
  query("vpc-old");
  const picker = document.querySelector<HTMLSelectElement>("#plan-selection");
  if (!picker) throw new Error("Missing picker");
  expect(picker.value).toBe("");
  picker.value = "older";
  picker.dispatchEvent(new Event("change"));
  expect(search().value).toBe("vpc-old");
  expect(document.querySelector("#plan-list article")?.getAttribute("data-plan-id")).toBe("older");
  const selectedSearch = search();
  click("#refresh");
  await vi.waitFor(() => expect(search()).not.toBe(selectedSearch));
  expect(search().value).toBe("vpc-old");
  expect(JSON.parse(document.querySelector("#plan-list article details pre")?.textContent ?? "null")).toEqual(
    snapshot.plans[1],
  );
  retained.value = "stale";
  retained.dispatchEvent(new Event("input"));
  expect(search().value).toBe("vpc-old");
  const away = search();
  window.location.hash = "#/overview";
  await vi.waitFor(() => expect(document.querySelector("#plans")?.hasAttribute("hidden")).toBe(true));
  away.value = "stale-away";
  away.dispatchEvent(new Event("input"));
  window.location.hash = "#/plans";
  await vi.waitFor(() => expect(document.querySelector("#plans")?.hasAttribute("hidden")).toBe(false));
  click("#refresh");
  await vi.waitFor(() => expect(search()).not.toBe(away));
  expect(search().value).toBe("vpc-old");
  click("#logout");
  retained.dispatchEvent(new Event("input"));
  await login();
  expect(search().value).toBe("");
  expect(document.querySelectorAll("#plan-selection option")).toHaveLength(2);
  expect(fetcher.mock.calls.every(([input]) => String(input) === "/api/v1/snapshot")).toBe(true);
});

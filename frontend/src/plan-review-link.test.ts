import { afterEach, expect, it, vi } from "vitest";
import type { Plan, Snapshot } from "./generated";
import { planReviewHref, readPlanReviewIntent } from "./plan-review-link";
import { renderPlanReview } from "./plan-review-view";

function plan(id: string): Plan {
  return {
    id,
    digest: `digest-${id}`,
    scope: "scope",
    scope_version: 0,
    inventory_revision: 1,
    network_revision: 1,
    request: {
      account_id: "registration-not-in-link",
      vpc_id: "vpc-not-in-link",
      network_id: "network-not-in-link",
      subnet_ids: ["subnet-not-in-link"],
      allow_application_traffic: false,
    },
    actions: [
      {
        kind: "attachment",
        target: "target-not-in-link",
        requires: [],
        postcondition: "required, not observed",
      },
    ],
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("links the exact nonfirst original returned plan without encoding its request or changing evidence", () => {
  const plans = [plan("11111111-1111-4111-8111-111111111111"), plan("22222222-2222-4222-8222-222222222222")];
  const original = plans[1];
  if (!original) throw new Error("Missing original plan");
  const before = structuredClone(plans);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const root = renderPlanReview(plans, {
    selectedPlanId: original.id,
    isCurrent: () => true,
    onSelect: vi.fn(),
    makeApply: () => {
      const button = document.createElement("button");
      button.textContent = "Apply original";
      button.disabled = true;
      return button;
    },
  });
  document.body.append(root);
  const link = root.querySelector<HTMLAnchorElement>("a[data-plan-review-link]");
  expect(link).not.toBeNull();
  expect(link?.textContent).toBe("Link to this returned plan");
  expect(link?.getAttribute("href")).toBe(`#/plans?plan=${encodeURIComponent(original.id)}`);
  expect(link?.getAttribute("href")).not.toContain(original.request.account_id);
  expect(link?.getAttribute("href")).not.toContain(original.request.vpc_id);
  if (!link) throw new Error("Missing original plan link");
  const click = new MouseEvent("click", { cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
  expect(root.querySelector("button")?.textContent).toBe("Apply original");
  expect(JSON.parse(root.querySelector("details pre")?.textContent ?? "null")).toEqual(original);
  expect(plans).toEqual(before);
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves literal bounded URI identities and refuses invalid or retired link activation atomically", () => {
  for (const id of ["a+b", " a ", "%&?=#/<>", "é", "𐀀", "a".repeat(2048), "é".repeat(1024)]) {
    const href = planReviewHref(id);
    expect(href).toBeDefined();
    expect(readPlanReviewIntent(href ?? "")).toEqual({ kind: "plan", id, hash: href });
  }
  expect(readPlanReviewIntent("#/plans?plan=a+b")).toEqual({
    kind: "plan",
    id: "a+b",
    hash: "#/plans?plan=a%2Bb",
  });
  for (const id of [
    null,
    undefined,
    4,
    {},
    "",
    "\n",
    "\u0085",
    "a\u0000b",
    "\ud800",
    "\udfff",
    "x".repeat(2049),
    "é".repeat(1025),
  ])
    expect(planReviewHref(id)).toBeUndefined();
  for (const hash of [
    "#/plans?plan",
    "#/plans?plan=",
    "#/plans?plan=%",
    "#/plans?plan=%ZZ",
    "#/plans?plan=%C0%AF",
    "#/plans?plan=%ED%A0%80",
    "#/plans?plan=%00",
    "#/plans?plan=a&plan=b",
    "#/plans?plan=a&token=not-used",
    `#/plans?plan=${"x".repeat(8193)}`,
  ]) {
    expect(readPlanReviewIntent(hash)).toEqual({ kind: "invalid", hash: "#/plans?plan=" });
  }
  for (const hash of ["#/plans", "#/accounts", "#/plans?token=not-used", "#/plans?Plan=other"])
    expect(readPlanReviewIntent(hash)).toEqual({ kind: "none" });
  const original = plan("22222222-2222-4222-8222-222222222222"),
    plans = [original];
  let live = true;
  const root = renderPlanReview(plans, {
    isCurrent: () => live,
    onSelect: vi.fn(),
    makeApply: () => document.createElement("button"),
  });
  document.body.append(root);
  const link = root.querySelector<HTMLAnchorElement>("[data-plan-review-link]"),
    card = link?.parentElement;
  if (!link || !card) throw new Error("Missing original link");
  const refused = () => {
    const event = new MouseEvent("click", { cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  link.setAttribute("aria-disabled", "true");
  refused();
  link.removeAttribute("aria-disabled");
  const href = link.getAttribute("href");
  if (!href) throw new Error("Missing original href");
  link.setAttribute("href", "#/accounts");
  refused();
  link.setAttribute("href", href);
  live = false;
  refused();
  live = true;
  link.remove();
  refused();
  card.append(link);
  root.remove();
  refused();
  document.body.append(root);
  const id = original.id;
  original.id = "changed";
  refused();
  original.id = id;
  plans[0] = { ...original };
  refused();
  plans[0] = original;
  Reflect.set(original.request, "cycle", original.request);
  refused();
  Reflect.deleteProperty(original.request, "cycle");
});

it("the real parent restores exact URI intent, switches same-view history, and clears explicit intent after manual selection", async () => {
  vi.resetModules();
  const first = "11111111-1111-4111-8111-111111111111",
    second = "22222222-2222-4222-8222-222222222222";
  const state = (): Snapshot => ({
    accounts: [
      {
        id: "registration-not-in-link",
        name: "Account",
        provider: "fake",
        revision: 1,
        role_arn: "fake:role",
      },
    ],
    inventory: [
      {
        account_id: "registration-not-in-link",
        vpc_id: "vpc-not-in-link",
        region: "eu-west-1",
        cidr: "10.0.0.0/16",
        revision: 1,
        subnets: [{ id: "subnet-not-in-link", az_id: "az", route_table: "rtb", default_route_managed: true }],
      },
    ],
    networks: [
      {
        id: "network-not-in-link",
        name: "Network",
        region: "eu-west-1",
        revision: 1,
        egress_cidr: "10.250.0.0/16",
        az_ids: ["az"],
        public_ips: [],
        application_cidrs: [],
        managed_nat: true,
      },
    ],
    plans: [plan(first), plan(second)],
    operations: [],
    mode: "demo",
    role: "read_only",
    aws_accounts: [],
    aws_regions: [],
    aws_read_only_enabled: false,
  });
  let responseSnapshot = state();
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/v1/snapshot") throw new Error(`Unexpected request ${input}`);
    return new Response(JSON.stringify(responseSnapshot));
  });
  vi.stubGlobal("fetch", fetcher);
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", `#/plans?plan=${second}`);
  await import("./main");
  const login = () => {
    const token = document.querySelector<HTMLInputElement>("#token"),
      form = document.querySelector("#login");
    if (!token || !form) throw new Error("Missing authentication");
    token.value = "fixture-reader";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  };
  const selected = () => document.querySelector<HTMLElement>("#plan-list article")?.dataset.planId;
  login();
  await vi.waitFor(() => expect(selected()).toBe(second));
  expect(fetcher).toHaveBeenCalledTimes(1);
  window.location.hash = `#/plans?plan=${first}`;
  await vi.waitFor(() => expect(selected()).toBe(first));
  expect(fetcher).toHaveBeenCalledTimes(1);
  window.location.hash = "#/plans?plan=absent-returned-plan";
  await vi.waitFor(() => expect(selected()).toBeUndefined());
  expect(document.querySelector("#plan-list")?.textContent).toContain(
    "Selected plan unavailable or ambiguous",
  );
  window.location.hash = "#/plans?plan=%ZZ";
  await vi.waitFor(() => expect(window.location.hash).toBe("#/plans?plan="));
  expect(selected()).toBeUndefined();
  window.location.hash = `#/plans?plan=${first}`;
  await vi.waitFor(() => expect(selected()).toBe(first));
  window.history.pushState(null, "", `#/plans?plan=${second}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await vi.waitFor(() => expect(selected()).toBe(second));
  window.history.back();
  await vi.waitFor(() => expect(selected()).toBe(first));
  window.history.forward();
  await vi.waitFor(() => expect(selected()).toBe(second));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const picker = document.querySelector<HTMLSelectElement>("#plan-selection");
  if (!picker) throw new Error("Missing returned Plan selection");
  picker.value = first;
  picker.dispatchEvent(new Event("change"));
  expect(selected()).toBe(first);
  expect(window.location.hash).toBe("#/plans");
  const oldCard = document.querySelector("#plan-list article");
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(document.querySelector("#plan-list article")).not.toBe(oldCard));
  expect(selected()).toBe(first);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const duplicate = responseSnapshot.plans[0];
  if (!duplicate) throw new Error("Missing duplicate fixture");
  responseSnapshot.plans.push({ ...duplicate });
  document.querySelector<HTMLButtonElement>("#refresh")?.click();
  await vi.waitFor(() => expect(selected()).toBeUndefined());
  expect(document.querySelector("#plan-list")?.textContent).toContain(
    "Selected plan unavailable or ambiguous",
  );
  responseSnapshot = state();
  window.location.hash = `#/plans?plan=${second}`;
  await vi.waitFor(() => expect(selected()).toBe(second));
  document.querySelector<HTMLButtonElement>("#logout")?.click();
  login();
  await vi.waitFor(() => expect(selected()).toBe(second));
});

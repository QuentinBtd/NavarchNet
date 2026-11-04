import { afterEach, expect, it, vi } from "vitest";
import type { Inventory, RegionalNetwork, Snapshot } from "./generated";
import { renderNetworkWorkspace } from "./network-workspace";

function state(): Pick<Snapshot, "accounts" | "inventory" | "networks"> {
  const network: RegionalNetwork = {
    id: "net",
    name: "Actual returned name",
    region: "eu-west-1",
    revision: 9,
    egress_cidr: "10.250.0.0/16",
    az_ids: ["az-a", "az-b"],
    public_ips: ["192.0.2.44"],
    application_cidrs: [],
    managed_nat: true,
  };
  const inventory: Inventory = {
    account_id: "app",
    vpc_id: "vpc-actual",
    region: "eu-west-1",
    cidr: "10.23.0.0/16",
    revision: 7,
    subnets: [{ id: "subnet", az_id: "az-a", route_table: "rtb", default_route_managed: false }],
  };
  return {
    networks: [network],
    inventory: [inventory],
    accounts: [{ id: "app", name: "Application", provider: "fake", revision: 1, role_arn: "fake:role" }],
  };
}
function mount(data = state(), isCurrent = () => true) {
  const onSelection = vi.fn();
  const root = renderNetworkWorkspace(data, { selection: {}, isCurrent, onSelection });
  document.body.append(root);
  return { root, onSelection };
}
function choose(root: HTMLElement, id: string, value: string) {
  const select = root.querySelector<HTMLSelectElement>(`#${id}`);
  if (!select) throw new Error("Missing selection");
  select.value = value;
  select.dispatchEvent(new Event("change"));
}
function button(root: HTMLElement, name: string) {
  const node = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent === name,
  );
  if (!node) throw new Error(`Missing button ${name}`);
  return node;
}
async function original(root: HTMLElement) {
  const details = root.querySelector<HTMLDetailsElement>("aside details");
  if (!details) throw new Error("Missing original data");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  return JSON.parse(root.querySelector("aside pre")?.textContent ?? "null");
}
afterEach(() => document.body.replaceChildren());

it("draws actual returned simulation fields with complete original data and no inferred links", async () => {
  const data = state(),
    before = structuredClone(data);
  const { root } = mount(data);
  expect(root.textContent).toContain("10.23.0.0/16");
  expect(root.textContent).toContain("10.250.0.0/16");
  expect(root.textContent).toContain("Same region does not establish a connection");
  expect(root.querySelectorAll("svg,path,img")).toHaveLength(0);
  expect(await original(root)).toEqual(data.inventory[0]);
  button(root, "Inspect regional network Actual returned name").click();
  expect(root.querySelector("aside")?.textContent).toContain("Used egress and connectivity are unknown");
  expect(await original(root)).toEqual(data.networks[0]);
  expect(data).toEqual(before);
});

it("keeps same VPC literals in different accounts distinct and excludes other regions and AWS inventories", () => {
  const data = state();
  data.accounts.push(
    { ...data.accounts[0], id: "other", name: "Other account" },
    { ...data.accounts[0], id: "aws", provider: "aws" },
  );
  data.inventory.push(
    { ...data.inventory[0], account_id: "other", cidr: "10.24.0.0/16" },
    { ...data.inventory[0], account_id: "aws", vpc_id: "vpc-aws" },
    { ...data.inventory[0], vpc_id: "vpc-other-region", region: "us-east-1" },
  );
  const { root } = mount(data);
  expect(root.querySelectorAll("#workspace-vpc option")).toHaveLength(2);
  choose(root, "workspace-vpc", JSON.stringify(["other", "vpc-actual"]));
  expect(root.querySelector("aside")?.textContent).toContain("Other account");
  expect(root.querySelector("aside")?.textContent).toContain("10.24.0.0/16");
  expect(root.textContent).not.toContain("vpc-aws");
  expect(root.textContent).not.toContain("vpc-other-region");
});

it("rejects duplicate or malformed complete context before drawing a plausible prefix", () => {
  const cases = [state(), state(), state(), state()];
  cases[0].networks.push({ ...cases[0].networks[0] });
  cases[1].inventory.push({ ...cases[1].inventory[0] });
  cases[2].inventory[0].subnets = Array(3) as Inventory["subnets"];
  cases[3].networks[0].revision = Number.MAX_SAFE_INTEGER + 1;
  for (const data of cases) {
    const { root } = mount(data);
    expect(root.textContent).toContain("unavailable or ambiguous");
    expect(root.querySelectorAll(".network-map-node")).toHaveLength(0);
  }
});

it("retired local nodes, details and links cannot affect a newer selection or leave the view", () => {
  let current = true;
  const { root, onSelection } = mount(state(), () => current);
  const oldNode = button(root, "Inspect application VPC vpc-actual");
  const oldDetails = root.querySelector<HTMLDetailsElement>("aside details");
  const oldLink = root.querySelector<HTMLAnchorElement>("a");
  button(root, "Inspect regional network Actual returned name").click();
  onSelection.mockClear();
  oldNode.click();
  if (oldDetails) oldDetails.open = true;
  oldDetails?.dispatchEvent(new Event("toggle"));
  expect(root.querySelector("aside h3")?.textContent).toBe("Actual returned name");
  expect(onSelection).not.toHaveBeenCalled();
  const event = new MouseEvent("click", { cancelable: true });
  oldLink?.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  current = false;
  button(root, "Inspect application VPC vpc-actual").click();
  expect(onSelection).not.toHaveBeenCalled();
  root.remove();
  oldNode.click();
  expect(onSelection).not.toHaveBeenCalled();
});

it("shows all returned subnets through bounded batches without filtering false management values", async () => {
  const data = state();
  data.inventory[0].subnets = Array.from({ length: 13 }, (_, i) => ({
    id: `subnet-${i}`,
    az_id: `az-${i}`,
    route_table: `rtb-${i}`,
    default_route_managed: false,
  }));
  const { root } = mount(data);
  expect(root.querySelectorAll(".network-map-subnets button")).toHaveLength(6);
  const retiredMore = button(root, "Show more subnets (6 of 13 shown)");
  retiredMore.click();
  retiredMore.click();
  expect(root.querySelectorAll(".network-map-subnets button")).toHaveLength(12);
  button(root, "Show more subnets (12 of 13 shown)").click();
  expect(root.querySelectorAll(".network-map-subnets button")).toHaveLength(13);
  button(root, "Inspect subnet subnet-12").click();
  expect(await original(root)).toEqual(data.inventory[0].subnets[12]);
  expect(root.querySelector("aside")?.textContent).toContain("Not declared managed");
});

it("provider text stays inert and fixed navigation never borrows provider input", () => {
  const data = state();
  data.networks[0].name = '<img src=x onerror="throw 1">';
  data.accounts[0].name = "<script>unsafe</script>";
  const { root } = mount(data);
  expect(root.textContent).toContain(data.networks[0].name);
  expect(root.querySelectorAll("img,script")).toHaveLength(0);
  expect([...root.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
    "#/connections",
    "#/plans",
    "#/aws",
  ]);
});

it("empty or unpaired scope remains explicit instead of fabricating resources or owner identity", () => {
  const empty = state();
  empty.networks = [];
  expect(mount(empty).root.textContent).toContain("No regional networks returned");
  const unpaired = state();
  unpaired.inventory = [];
  const { root } = mount(unpaired);
  expect(root.textContent).toContain("No same-region simulation inventory returned");
  expect(root.querySelector("aside")?.textContent).toContain("Not reported by this model");
  expect(root.querySelectorAll(".network-map-node")).toHaveLength(1);
});

it("hands off only the current exact map scope and rejects retired or downgraded configure controls", () => {
  const data = state();
  data.accounts.push({ ...data.accounts[0], id: "other" });
  data.inventory.push({ ...data.inventory[0], account_id: "other" });
  let current = true,
    allowed = true;
  const onConfigure = vi.fn();
  const root = renderNetworkWorkspace(data, {
    selection: {},
    isCurrent: () => current,
    onSelection: () => {},
    get canConfigure() {
      return allowed;
    },
    onConfigure,
  });
  document.body.append(root);
  const old = button(root, "Configure selected VPC");
  choose(root, "workspace-vpc", JSON.stringify(["other", "vpc-actual"]));
  old.click();
  expect(onConfigure).not.toHaveBeenCalled();
  const live = button(root, "Configure selected VPC");
  live.click();
  expect(onConfigure).toHaveBeenCalledExactlyOnceWith(data.inventory[1], data.networks[0]);
  allowed = false;
  live.click();
  allowed = true;
  current = false;
  live.click();
  root.remove();
  current = true;
  live.click();
  expect(onConfigure).toHaveBeenCalledTimes(1);
  const reader = renderNetworkWorkspace(data, {
    selection: {},
    isCurrent: () => true,
    onSelection: () => {},
    canConfigure: false,
    onConfigure,
  });
  document.body.append(reader);
  const disabled = button(reader, "Configure selected VPC");
  expect(disabled.disabled).toBe(true);
  disabled.disabled = false;
  disabled.click();
  expect(onConfigure).toHaveBeenCalledTimes(1);
});

it("selected-subnet handoff retains exact row identity and rejects ambiguity or retired permissions", async () => {
  const data = state(),
    inventory = data.inventory[0],
    first = inventory.subnets[0];
  inventory.subnets.push({ ...first, id: " <subnet-b> ", az_id: "az-b" });
  const onConfigure = vi.fn();
  let current = true,
    allowed = true;
  const root = renderNetworkWorkspace(data, {
    selection: {},
    isCurrent: () => current,
    onSelection: () => {},
    get canConfigure() {
      return allowed;
    },
    onConfigure,
  });
  document.body.append(root);
  expect(
    [...root.querySelectorAll("button")].some((b) => b.textContent === "Configure selected subnet"),
  ).toBe(false);
  button(root, `Inspect subnet ${inventory.subnets[1].id}`).click();
  expect(root.querySelector("aside dt")?.textContent).toBe("Subnet ID");
  expect(root.querySelector("aside dd")?.textContent).toBe(inventory.subnets[1].id);
  expect(root.querySelectorAll("img,script")).toHaveLength(0);
  expect(await original(root)).toEqual(inventory.subnets[1]);
  const old = button(root, "Configure selected subnet");
  old.click();
  expect(onConfigure).toHaveBeenCalledExactlyOnceWith(inventory, data.networks[0], inventory.subnets[1]);
  button(root, `Inspect subnet ${first.id}`).click();
  old.click();
  const live = button(root, "Configure selected subnet");
  allowed = false;
  live.click();
  allowed = true;
  current = false;
  live.click();
  current = true;
  root.remove();
  live.click();
  expect(onConfigure).toHaveBeenCalledTimes(1);
  for (const duplicate of [true, false]) {
    const repeated = state(),
      row = repeated.inventory[0].subnets[0];
    repeated.inventory[0].subnets.push({ ...row, id: duplicate ? row.id : "other" });
    const rendered = renderNetworkWorkspace(repeated, {
      selection: {},
      isCurrent: () => true,
      onSelection: () => {},
      canConfigure: duplicate,
      onConfigure,
    });
    document.body.append(rendered);
    button(rendered, `Inspect subnet ${row.id}`).click();
    const blocked = button(rendered, "Configure selected subnet");
    expect(blocked.disabled).toBe(true);
    blocked.disabled = false;
    blocked.click();
    expect(onConfigure).toHaveBeenCalledTimes(1);
    if (duplicate)
      expect(rendered.querySelector("aside")?.textContent).toContain("Selected subnet identity is ambiguous");
  }
});

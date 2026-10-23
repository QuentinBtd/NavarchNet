import type { Inventory, RegionalNetwork, Snapshot, Subnet } from "./generated";
import { text } from "./view";

type Selection = { networkId?: string; inventoryKey?: string };
type Context = Pick<Snapshot, "accounts" | "inventory" | "networks">;
type Options = {
  selection: Selection;
  isCurrent: () => boolean;
  onSelection: (selection: Selection) => void;
  canConfigure?: boolean;
  onConfigure?: (inventory: Inventory, network: RegionalNetwork, subnet?: Subnet) => void;
};
type Resource = { kind: "network" } | { kind: "vpc" } | { kind: "subnet"; index: number };
const inventoryKey = (i: Inventory) => JSON.stringify([i.account_id, i.vpc_id]);
const literal = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
function collection<T>(values: T[], valid: (value: T) => boolean): boolean {
  if (!Array.isArray(values)) return false;
  for (let i = 0; i < values.length; i++)
    if (!Object.hasOwn(values, i) || !values[i] || !valid(values[i])) return false;
  return true;
}
function validContext(data: Context) {
  return (
    collection(
      data.accounts,
      (a) => literal(a.id) && literal(a.name) && ["fake", "aws"].includes(a.provider),
    ) &&
    collection(
      data.networks,
      (n) =>
        [n.id, n.name, n.region, n.egress_cidr].every(literal) &&
        revision(n.revision) &&
        collection(n.az_ids, literal) &&
        collection(n.public_ips, literal) &&
        typeof n.managed_nat === "boolean",
    ) &&
    collection(
      data.inventory,
      (i) =>
        [i.account_id, i.vpc_id, i.region, i.cidr].every(literal) &&
        revision(i.revision) &&
        collection(
          i.subnets,
          (s) =>
            [s.id, s.az_id, s.route_table].every(literal) && typeof s.default_route_managed === "boolean",
        ),
    ) &&
    new Set(data.networks.map((n) => n.id)).size === data.networks.length &&
    new Set(data.accounts.map((a) => a.id)).size === data.accounts.length &&
    new Set(data.inventory.map(inventoryKey)).size === data.inventory.length
  );
}

// Presentation of the authenticated simulation snapshot only. No route inference, requests or writes.
export function renderNetworkWorkspace(data: Context, options: Options): HTMLElement {
  const root = document.createElement("div");
  root.className = "network-workspace";
  if (!validContext(data)) {
    root.append(text("p", "Network context unavailable or ambiguous. Refresh the snapshot."));
    return root;
  }
  if (data.networks.length === 0) {
    root.append(text("p", "No regional networks returned. Create a simulated network to explore its scope."));
    return root;
  }
  let selected = { ...options.selection };
  let resource: Resource = { kind: "vpc" };
  let subnetLimit = 6;
  let version = 0;
  const isCurrent = () => root.isConnected && options.isCurrent();
  function draw(focus?: string) {
    const epoch = ++version;
    const network = data.networks.find((n) => n.id === selected.networkId) ?? data.networks[0];
    if (!network) return;
    const eligible = data.inventory.filter(
      (i) =>
        i.region === network.region &&
        data.accounts.some((a) => a.id === i.account_id && a.provider === "fake"),
    );
    const inventory = eligible.find((i) => inventoryKey(i) === selected.inventoryKey) ?? eligible[0];
    selected = { networkId: network.id, inventoryKey: inventory ? inventoryKey(inventory) : undefined };
    options.onSelection({ ...selected });
    if (!inventory) resource = { kind: "network" };
    const account = data.accounts.find((a) => a.id === inventory?.account_id);
    const active = (node: HTMLElement) => isCurrent() && version === epoch && root.contains(node);
    const controls = document.createElement("div");
    controls.className = "network-map-controls";
    function selector(
      id: string,
      label: string,
      values: { id: string; label: string }[],
      value: string | undefined,
      change: (value: string) => void,
    ) {
      const field = document.createElement("div");
      const name = text("label", label);
      name.htmlFor = id;
      const input = document.createElement("select");
      input.id = id;
      for (const item of values) {
        const option = text("option", item.label);
        option.value = item.id;
        input.append(option);
      }
      input.value = value ?? "";
      input.disabled = values.length === 0;
      input.onchange = () => {
        if (active(input)) change(input.value);
      };
      field.append(name, input);
      controls.append(field);
    }
    selector(
      "workspace-network",
      "Regional network in workspace",
      data.networks.map((n) => ({ id: n.id, label: `${n.name} · ${n.region}` })),
      selected.networkId,
      (id) => {
        selected = { networkId: id };
        resource = { kind: "network" };
        subnetLimit = 6;
        draw("workspace-network");
      },
    );
    selector(
      "workspace-vpc",
      "VPC in workspace",
      eligible.map((i) => ({
        id: inventoryKey(i),
        label: `${data.accounts.find((a) => a.id === i.account_id)?.name} · ${i.cidr} · ${i.vpc_id}`,
      })),
      selected.inventoryKey,
      (key) => {
        selected.inventoryKey = key;
        resource = { kind: "vpc" };
        subnetLimit = 6;
        draw("workspace-vpc");
      },
    );
    const body = document.createElement("div");
    body.className = "network-map-layout";
    const map = document.createElement("div");
    map.className = "network-map";
    map.setAttribute("role", "region");
    map.setAttribute("aria-label", "Simulation network map");
    function node(label: string, title: string, detail: string, next: Resource) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "network-map-node";
      button.setAttribute("aria-label", label);
      button.setAttribute(
        "aria-pressed",
        String(
          resource.kind === next.kind &&
            (next.kind !== "subnet" || (resource.kind === "subnet" && resource.index === next.index)),
        ),
      );
      button.append(text("strong", title), text("span", detail));
      button.onclick = () => {
        if (active(button)) {
          resource = next;
          draw();
          root.querySelector<HTMLButtonElement>("[aria-pressed=true]")?.focus();
        }
      };
      return button;
    }
    const application = document.createElement("div");
    application.className = "network-map-scope";
    application.append(text("h3", account ? `${account.name} · application scope` : "Application inventory"));
    if (inventory) {
      application.append(
        node(
          `Inspect application VPC ${inventory.vpc_id}`,
          `Application VPC · ${inventory.cidr}`,
          `${inventory.region} · simulated discovery`,
          { kind: "vpc" },
        ),
      );
      application.append(text("p", `${inventory.subnets.length} returned subnets · no traffic AZ inferred`));
      const subnets = document.createElement("div");
      subnets.className = "network-map-subnets";
      for (const [index, subnet] of inventory.subnets.slice(0, subnetLimit).entries())
        subnets.append(
          node(`Inspect subnet ${subnet.id}`, subnet.az_id, "Subnet · reported AZ ID", {
            kind: "subnet",
            index,
          }),
        );
      application.append(subnets);
      if (inventory.subnets.length > subnetLimit) {
        const more = text(
          "button",
          `Show more subnets (${Math.min(subnetLimit, inventory.subnets.length)} of ${inventory.subnets.length} shown)`,
        );
        more.type = "button";
        more.onclick = () => {
          if (active(more)) {
            subnetLimit += 6;
            draw();
          }
        };
        application.append(more);
      }
    } else
      application.append(
        text("p", "No same-region simulation inventory returned. Discover an application account first."),
      );
    const gap = text("p", "Same region does not establish a connection");
    gap.className = "network-map-gap";
    const region = document.createElement("div");
    region.className = "network-map-scope";
    region.append(text("h3", `${network.region} · regional network scope`));
    region.append(
      node(
        `Inspect regional network ${network.name}`,
        network.name,
        `${network.egress_cidr} · declared simulation network`,
        { kind: "network" },
      ),
    );
    region.append(
      text(
        "p",
        network.managed_nat ? "Managed NAT capability declared" : "Managed NAT capability not declared",
      ),
    );
    region.append(text("p", "TGW/NAT identities and owner: not supplied"));
    map.append(application, gap, region);
    const aside = document.createElement("aside");
    aside.className = "network-resource-inspector";
    aside.setAttribute("aria-label", "Network resource inspector");
    const fields = document.createElement("dl");
    function field(label: string, value: string) {
      fields.append(text("dt", label), text("dd", value));
    }
    let original: Inventory | RegionalNetwork | Subnet = network;
    let title = network.name;
    if (inventory && resource.kind === "subnet" && inventory.subnets[resource.index]) {
      const subnet = inventory.subnets[resource.index];
      original = subnet;
      title = `Subnet · ${subnet.az_id}`;
      field("Subnet ID", subnet.id);
      field("Application account", account?.name ?? "Unknown");
      field("Parent VPC", inventory.vpc_id);
      field("Reported AZ ID", subnet.az_id);
      field("Route table", subnet.route_table);
      field(
        "Default-route management",
        subnet.default_route_managed ? "Declared managed in simulation" : "Not declared managed",
      );
      field("Inventory revision", String(inventory.revision));
    } else if (inventory && resource.kind === "vpc") {
      original = inventory;
      title = "Application VPC";
      field("Application account", account?.name ?? "Unknown");
      field("CIDR / region", `${inventory.cidr} · ${inventory.region}`);
      field("Returned subnets", String(inventory.subnets.length));
      field("Inventory revision", String(inventory.revision));
    } else {
      field("Region / egress CIDR", `${network.region} · ${network.egress_cidr}`);
      field("Declared AZ IDs", network.az_ids.join(", ") || "None reported");
      field("Simulation address values", network.public_ips.join(", ") || "None reported");
      field("Network revision", String(network.revision));
      field("Network owner account", "Not reported by this model");
    }
    aside.append(text("h3", title), text("p", "Simulation · authenticated API snapshot"), fields);
    aside.append(
      text(
        "p",
        "Used egress and connectivity are unknown. No traffic, health or applied connection is inferred.",
      ),
    );
    const details = document.createElement("details");
    details.append(text("summary", "Original returned data"));
    details.ontoggle = () => {
      if (details.open && active(details) && !details.querySelector("pre"))
        details.append(text("pre", JSON.stringify(original, null, 2)));
    };
    aside.append(details);
    body.append(map, aside);
    const explanation = text(
      "p",
      `Scope view: ${inventory ? `${account?.name} / ${inventory.cidr}` : "no selected application inventory"} and ${network.name} in ${network.region}. These are separate snapshot records, not a forward/return path. Layout does not assert attachment, route or NAT readiness.`,
    );
    explanation.className = "network-map-explanation";
    const explanationDetails = document.createElement("details");
    explanationDetails.append(text("summary", "Scope and evidence explanation"), explanation);
    const provenance = text("p", "Simulation data · connection and connectivity are not inferred here.");
    provenance.className = "network-map-legend";
    const actions = document.createElement("div");
    actions.className = "network-map-actions";
    if (inventory && options.onConfigure) {
      const subnet = resource.kind === "subnet" ? inventory.subnets[resource.index] : undefined;
      if (subnet) {
        const unique = () =>
          inventory.subnets.includes(subnet) &&
          inventory.subnets.filter((s) => s.id === subnet.id).length === 1;
        const configureSubnet = text("button", "Configure selected subnet");
        configureSubnet.type = "button";
        configureSubnet.disabled = options.canConfigure !== true || !unique();
        configureSubnet.onclick = () => {
          if (
            !configureSubnet.disabled &&
            active(configureSubnet) &&
            options.canConfigure === true &&
            unique()
          )
            options.onConfigure?.(inventory, network, subnet);
        };
        if (!unique())
          aside.append(
            text("p", "Selected subnet identity is ambiguous. Refresh discovery or select a unique subnet."),
          );
        actions.append(configureSubnet);
      }
      const configure = text("button", "Configure selected VPC");
      configure.type = "button";
      configure.disabled = options.canConfigure !== true;
      configure.onclick = () => {
        if (!configure.disabled && active(configure) && options.canConfigure === true)
          options.onConfigure?.(inventory, network);
      };
      actions.append(configure);
    }
    for (const [label, href] of [
      ["Select VPCs & plan a connection", "#/connections"],
      ["Review returned plans", "#/plans"],
      ["Inspect saved AWS separately", "#/aws"],
    ]) {
      const link = text("a", label);
      link.href = href;
      link.onclick = (event) => {
        if (!active(link)) event.preventDefault();
      };
      actions.append(link);
    }
    root.replaceChildren(controls, body, provenance, explanationDetails, actions);
    if (focus) root.querySelector<HTMLElement>(`#${focus}`)?.focus();
  }
  draw();
  return root;
}

import { renderCapturedRouteRecords } from "./captured-route-records";
import type { AwsTopology, ResourceKind, TopologyView } from "./generated";
import { renderNatMetadata } from "./nat-metadata-view";
import { text } from "./view";

const kinds: Record<ResourceKind, string> = {
  vpc: "VPC",
  subnet: "Subnet",
  route_table: "VPC route table",
  transit_gateway: "Transit gateway",
  vpc_attachment: "VPC attachment",
  nat_gateway: "NAT record",
  internet_gateway: "Internet gateway",
  elastic_ip: "Address record",
  transit_gateway_route_table: "TGW route table",
  ram_share: "RAM share",
  ram_resource: "Shared resource",
  ram_principal: "Sharing principal",
  ram_invitation: "Sharing invitation",
};
const lanes: Record<ResourceKind, string> = {
  vpc: "VPC records",
  subnet: "Subnet records",
  route_table: "Route and transit records",
  transit_gateway: "Route and transit records",
  vpc_attachment: "Route and transit records",
  transit_gateway_route_table: "Route and transit records",
  nat_gateway: "Gateway and address records",
  internet_gateway: "Gateway and address records",
  elastic_ip: "Gateway and address records",
  ram_share: "Sharing records",
  ram_resource: "Sharing records",
  ram_principal: "Sharing records",
  ram_invitation: "Sharing records",
};
const scalar = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const nullable = (v: unknown) => v === null || typeof v === "string";
function strings(values: string[]): boolean {
  if (!Array.isArray(values)) return false;
  for (let i = 0; i < values.length; i++)
    if (!Object.hasOwn(values, i) || typeof values[i] !== "string") return false;
  return true;
}
function valid(topology: AwsTopology): boolean {
  if (
    ![
      topology.id,
      topology.account_id,
      topology.aws_account_id,
      topology.region,
      topology.completed_at,
    ].every(scalar) ||
    topology.execution_enabled !== false ||
    topology.connectivity_tested !== false ||
    typeof topology.complete_for_supported_queries !== "boolean" ||
    !Array.isArray(topology.resources)
  )
    return false;
  for (let i = 0; i < topology.resources.length; i++) {
    const r = topology.resources[i];
    if (
      !Object.hasOwn(topology.resources, i) ||
      !r ||
      !Object.hasOwn(kinds, r.kind) ||
      !scalar(r.id) ||
      ![r.owner_account_id, r.vpc_id, r.subnet_id, r.az_id, r.state].every(nullable) ||
      !strings(r.cidrs) ||
      !strings(r.public_ips) ||
      !r.tags ||
      typeof r.tags !== "object" ||
      Array.isArray(r.tags) ||
      !Object.values(r.tags).every((v) => typeof v === "string")
    )
      return false;
  }
  return true;
}
const reported = (value: string | null) =>
  value === null ? "Not reported" : value === "" ? "Empty reported value" : value;

type TableContext = Pick<TopologyView, "topology" | "subnet_route_tables">;
function validatedTableRows(topology: AwsTopology, context?: TableContext) {
  if (context?.topology !== topology || !Array.isArray(context.subnet_route_tables)) return;
  const rows = context.subnet_route_tables;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Object.hasOwn(rows, i) || !row || !scalar(row.subnet_id) || !nullable(row.vpc_id) || !row.selection)
      return;
    const selection = row.selection;
    if (selection.status === "selected") {
      if (
        !scalar(selection.route_table_id) ||
        !["explicit_subnet", "implicit_main"].includes(selection.source)
      )
        return;
    } else if (selection.status !== "unresolved" || !scalar(selection.reason)) return;
  }
  return rows;
}

// Kind grouping plus capture-bound returned calculations; no links, scope ownership or path are inferred.
export function renderSavedAwsWorkspace(
  topology: AwsTopology,
  isCurrent: () => boolean,
  context?: TableContext,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "saved-map-workspace";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Saved AWS resource map");
  if (!valid(topology)) {
    root.append(
      text(
        "p",
        "Saved resource map unavailable: capture identity, disabled markers or record fields are missing or invalid.",
      ),
    );
    return root;
  }
  root.dataset.topologyId = topology.id;
  root.dataset.completedAt = topology.completed_at;
  const tableRows = validatedTableRows(topology, context);
  const counts = new Map<string, number>();
  for (const record of topology.resources) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  let filter = "all",
    query = "",
    selected = 0,
    limit = 24,
    version = 0;
  function draw(focus?: "kind" | "search", cursor?: [number, number]) {
    const epoch = ++version;
    const active = (node: HTMLElement) =>
      root.isConnected && isCurrent() && version === epoch && root.contains(node);
    const indexes = topology.resources.flatMap((r, i) =>
      (filter === "all" || r.kind === filter) &&
      (r.id.includes(query) || (Object.hasOwn(r.tags, "Name") && r.tags.Name.includes(query)))
        ? [i]
        : [],
    );
    if (!indexes.includes(selected)) selected = indexes[0] ?? -1;
    const heading = text("h3", `Saved resources · ${topology.aws_account_id} · ${topology.region}`);
    const scope = text(
      "p",
      `Capture completed ${topology.completed_at} · ${topology.complete_for_supported_queries ? "supported-query scan complete" : "supported-query scan incomplete"}. Not a full cloud inventory or connectivity measurement.`,
    );
    const controls = document.createElement("div");
    controls.className = "saved-map-controls";
    const label = text("label", "Observed resource kind");
    label.htmlFor = "saved-map-kind";
    const select = document.createElement("select");
    select.id = label.htmlFor;
    const all = text("option", "All returned kinds");
    all.value = "all";
    select.append(all);
    for (const kind of new Set(topology.resources.map((r) => r.kind))) {
      const option = text("option", kinds[kind]);
      option.value = kind;
      select.append(option);
    }
    select.value = filter;
    select.onchange = () => {
      if (!active(select)) return;
      filter = select.value;
      selected = -1;
      limit = 24;
      draw("kind");
    };
    const kindControl = document.createElement("div");
    kindControl.append(label, select);
    const searchControl = document.createElement("div");
    const searchLabel = text("label", "Filter saved ID or Name (case-sensitive)");
    searchLabel.htmlFor = "saved-map-search";
    const search = document.createElement("input");
    search.id = searchLabel.htmlFor;
    search.type = "search";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.value = query;
    search.oninput = () => {
      if (!active(search)) return;
      query = search.value;
      selected = -1;
      limit = 24;
      draw("search", [search.selectionStart ?? query.length, search.selectionEnd ?? query.length]);
    };
    searchControl.append(searchLabel, search);
    controls.append(kindControl, searchControl);
    const count = text(
      "p",
      `Showing ${Math.min(limit, indexes.length)} of ${indexes.length} filtered records · ${topology.resources.length} records in this capture, not a cloud total.`,
    );
    const layout = document.createElement("div");
    layout.className = "saved-map-layout";
    const map = document.createElement("div");
    map.className = "saved-map-lanes";
    const groups = new Map<string, HTMLElement>();
    for (const index of indexes.slice(0, limit)) {
      const r = topology.resources[index];
      const lane = lanes[r.kind];
      let group = groups.get(lane);
      if (!group) {
        group = document.createElement("div");
        group.className = "saved-map-lane";
        group.append(text("h4", lane));
        groups.set(lane, group);
        map.append(group);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "saved-map-record";
      button.dataset.recordIndex = String(index);
      button.setAttribute("aria-label", `Inspect saved record ${index + 1}: ${r.kind} ${r.id}`);
      button.setAttribute("aria-pressed", String(selected === index));
      button.append(
        text("small", kinds[r.kind]),
        text("strong", Object.hasOwn(r.tags, "Name") && r.tags.Name !== "" ? r.tags.Name : r.id),
        text("span", `Reported state: ${reported(r.state)}`),
      );
      button.onclick = () => {
        if (!active(button)) return;
        selected = index;
        draw();
        root.querySelector<HTMLButtonElement>("[aria-pressed=true]")?.focus();
      };
      group.append(button);
    }
    if (!indexes.length)
      map.append(text("p", "No records returned for this selection. No resource absence is inferred."));
    const inspector = document.createElement("aside");
    inspector.className = "network-resource-inspector";
    inspector.setAttribute("aria-label", "Saved AWS record inspector");
    const record = topology.resources[selected];
    if (record) {
      inspector.append(text("h4", `${kinds[record.kind]} · ${record.id}`));
      const fields = document.createElement("dl");
      const field = (name: string, value: string) => fields.append(text("dt", name), text("dd", value));
      field("Original record position", String(selected + 1));
      field("Reported state", reported(record.state));
      field("Owner literal — not authority", reported(record.owner_account_id));
      field("VPC reference — unvalidated", reported(record.vpc_id));
      field("Subnet reference — unvalidated", reported(record.subnet_id));
      field("AZ ID — not traffic placement", reported(record.az_id));
      field("Reported CIDRs", record.cidrs.length ? record.cidrs.map(reported).join(", ") : "None reported");
      field(
        "Reported public IP values — not used egress",
        record.public_ips.length ? record.public_ips.map(reported).join(", ") : "None reported",
      );
      inspector.append(fields);
      if (record.kind === "subnet") {
        const calculated = document.createElement("div");
        calculated.dataset.capturedSubnetTable = "";
        calculated.append(
          text("strong", "Calculated table selection from this capture"),
          text("p", `Capture ${topology.id} · completed ${topology.completed_at}`),
        );
        const matches = tableRows?.filter((row) => row.subnet_id === record.id);
        const row =
          matches?.length === 1 && counts.get(record.id) === 1 && matches[0].vpc_id === record.vpc_id
            ? matches[0]
            : undefined;
        if (!row)
          calculated.append(
            text(
              "p",
              "Calculated table selection unavailable or ambiguous for this original record. Refresh the saved observation.",
            ),
          );
        else if (row.selection.status === "selected")
          calculated.append(
            text("p", `Selected table: ${row.selection.route_table_id}`),
            text("p", `Association source: ${row.selection.source}`),
          );
        else calculated.append(text("p", `Selection unresolved: ${row.selection.reason}`));
        calculated.append(text("p", "Not a destination-route decision, health check or verified path."));
        inspector.append(calculated);
      }
      if ((counts.get(record.id) ?? 0) !== 1)
        inspector.append(
          text("p", "This ID is not unique across captured records. No record correlation is established."),
        );
      inspector.append(
        text(
          "p",
          "Reported metadata is not health or a usable path. Unknown used egress and return routing remain unknown.",
        ),
      );
      const routes = renderCapturedRouteRecords(
        record,
        { id: topology.id, completed_at: topology.completed_at, resource_index: selected },
        () => active(inspector),
      );
      if (routes) inspector.append(routes);
      const original = document.createElement("details");
      original.append(text("summary", "Original captured record"));
      original.ontoggle = () => {
        if (original.open && active(original) && !original.querySelector("pre"))
          original.append(text("pre", JSON.stringify(record, null, 2)));
      };
      inspector.append(original);
      if (record.kind === "nat_gateway") {
        const metadata = renderNatMetadata(record, topology, () => active(metadata));
        inspector.append(metadata);
      }
    } else inspector.append(text("p", "Select a captured record to inspect its original metadata."));
    layout.append(map, inspector);
    const more = text("button", "Show more captured records");
    more.type = "button";
    more.hidden = limit >= indexes.length;
    more.onclick = () => {
      if (active(more)) {
        limit += 24;
        draw();
        [...root.querySelectorAll<HTMLButtonElement>("button[data-record-index]")].at(-1)?.focus();
      }
    };
    const explanation = document.createElement("details");
    explanation.append(text("summary", "Capture provenance and text explanation"));
    explanation.append(
      text(
        "p",
        `Account registration ${topology.account_id}, AWS-account field ${topology.aws_account_id}, region ${topology.region}, capture ${topology.id}, completed ${topology.completed_at}. Grouping is by record kind only, not an ownership boundary or physical topology. Each button uses its original full-capture index. No route, attachment, traffic or readiness links are drawn. All filtered records remain reachable with continuation.`,
      ),
    );
    explanation.append(
      text(
        "p",
        "AWS execution disabled · connectivity not tested. Incomplete scans and empty returns are not proof of absent resources. Existing saved diagnostics below remain separate calculations, not measured paths.",
      ),
    );
    root.replaceChildren(
      heading,
      scope,
      controls,
      count,
      layout,
      more,
      text("p", "Saved observation · kind grouping only · no inferred network links"),
      explanation,
    );
    if (focus === "kind") select.focus();
    if (focus === "search") {
      search.focus();
      if (cursor) search.setSelectionRange(...cursor);
    }
  }
  draw();
  return root;
}

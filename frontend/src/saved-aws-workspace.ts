import { renderCapturedRouteRecords } from "./captured-route-records";
import type { AwsResource, AwsTopology, ResourceKind, TopologyView } from "./generated";
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
  const sourceResources = topology.resources,
    sourceRows = context?.subnet_route_tables;
  const identity = () =>
    JSON.stringify([
      topology.id,
      topology.account_id,
      topology.aws_account_id,
      topology.region,
      topology.completed_at,
      topology.execution_enabled,
      topology.connectivity_tested,
      topology.complete_for_supported_queries,
    ]);
  const originalIdentity = identity();
  function tableFor(subnet: AwsResource) {
    if (
      topology.resources !== sourceResources ||
      context?.subnet_route_tables !== sourceRows ||
      identity() !== originalIdentity ||
      !valid(topology)
    )
      return;
    if (
      subnet.kind !== "subnet" ||
      !scalar(subnet.vpc_id) ||
      !topology.resources.includes(subnet) ||
      topology.resources.filter((r) => r.id === subnet.id).length !== 1
    )
      return;
    const rows = validatedTableRows(topology, context)?.filter((row) => row.subnet_id === subnet.id);
    const row = rows?.length === 1 ? rows[0] : undefined;
    if (!row || row.vpc_id !== subnet.vpc_id || row.selection.status !== "selected") return;
    const tableId = row.selection.route_table_id;
    const matches = topology.resources.flatMap((r, index) => (r.id === tableId ? [{ table: r, index }] : []));
    if (matches.length !== 1) return;
    const { table, index } = matches[0];
    if (table.kind !== "route_table" || table.vpc_id !== subnet.vpc_id) return;
    if (
      [subnet, table].some((r) => ["id", "kind", "vpc_id"].some((field) => !Object.hasOwn(r, field))) ||
      ["subnet_id", "vpc_id", "selection"].some((field) => !Object.hasOwn(row, field)) ||
      ["status", "route_table_id", "source"].some((field) => !Object.hasOwn(row.selection, field))
    )
      return;
    return { table, index, row };
  }
  type ReturnContext = {
    filter: string;
    query: string;
    selected: number;
    limit: number;
    start: number;
    subnet: AwsResource;
    table: AwsResource;
    valid: () => boolean;
  };
  let returnTo: ReturnContext | undefined;
  const counts = new Map<string, number>();
  for (const record of topology.resources) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  let filter = "all",
    query = "",
    selected = 0,
    limit = 24,
    start = 0,
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
      returnTo = undefined;
      start = 0;
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
      returnTo = undefined;
      start = 0;
      selected = -1;
      limit = 24;
      draw("search", [search.selectionStart ?? query.length, search.selectionEnd ?? query.length]);
    };
    searchControl.append(searchLabel, search);
    controls.append(kindControl, searchControl);
    const count = text(
      "p",
      `Showing ${Math.min(limit, indexes.length - start)} of ${indexes.length} filtered records · ${topology.resources.length} records in this capture, not a cloud total.${start ? ` Filtered positions ${start + 1}–${Math.min(start + limit, indexes.length)}.` : ""}`,
    );
    const layout = document.createElement("div");
    layout.className = "saved-map-layout";
    const map = document.createElement("div");
    map.className = "saved-map-lanes";
    const groups = new Map<string, HTMLElement>();
    for (const index of indexes.slice(start, start + limit)) {
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
        returnTo = undefined;
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
      const origin = returnTo;
      if (origin && record === origin.table) {
        const back = text("button", "Return to source subnet");
        back.type = "button";
        back.onclick = () => {
          if (
            back.disabled ||
            !active(back) ||
            back.parentElement !== inspector ||
            returnTo !== origin ||
            !origin.valid()
          )
            return;
          ({ filter, query, selected, limit, start } = origin);
          returnTo = undefined;
          draw();
          root.querySelector<HTMLButtonElement>(`button[data-record-index="${selected}"]`)?.focus();
        };
        inspector.append(
          text(
            "p",
            `Source subnet: ${origin.subnet.id} · same capture ${topology.id}. Not a destination-route decision, health check or verified path.`,
          ),
          back,
        );
      }
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
        else if (row.selection.status === "selected") {
          calculated.append(
            text("p", `Selected table: ${row.selection.route_table_id}`),
            text("p", `Association source: ${row.selection.source}`),
          );
          const target = tableFor(record);
          const sourceIndex = selected;
          let original: string | undefined;
          try {
            if (target) original = JSON.stringify([record, target.table, target.row]);
          } catch {
            /* Unserializable callback data cannot authorize navigation. */
          }
          const currentTarget = () => {
            try {
              const live = tableFor(record);
              return (
                !!target &&
                original !== undefined &&
                topology.resources[sourceIndex] === record &&
                live?.table === target.table &&
                live.row === target.row &&
                live.index === target.index &&
                JSON.stringify([record, live.table, live.row]) === original
              );
            } catch {
              return false;
            }
          };
          const inspect = text("button", "Inspect calculated table record");
          inspect.type = "button";
          inspect.disabled = !currentTarget();
          inspect.onclick = () => {
            if (
              inspect.disabled ||
              !active(inspect) ||
              inspect.parentElement !== calculated ||
              !target ||
              !currentTarget()
            )
              return;
            returnTo = {
              filter,
              query,
              selected,
              limit,
              start,
              subnet: record,
              table: target.table,
              valid: currentTarget,
            };
            filter = "route_table";
            query = "";
            selected = target.index;
            const position = topology.resources.filter((r) => r.kind === "route_table").indexOf(target.table);
            start = Math.floor(position / 24) * 24;
            limit = 24;
            draw();
            root.querySelector<HTMLButtonElement>(`button[data-record-index="${selected}"]`)?.focus();
          };
          calculated.append(inspect);
          if (inspect.disabled)
            calculated.append(
              text(
                "p",
                "Captured selected table record unavailable or ambiguous. Original subnet evidence is unchanged.",
              ),
            );
        } else calculated.append(text("p", `Selection unresolved: ${row.selection.reason}`));
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
    const earlier: HTMLElement[] = [];
    if (start > 0) {
      const previous = text("button", "Show earlier captured records");
      previous.type = "button";
      previous.onclick = () => {
        if (
          previous.disabled ||
          !active(previous) ||
          previous.parentElement !== root ||
          start <= 0 ||
          (returnTo && !returnTo.valid())
        )
          return;
        start = Math.max(0, start - 24);
        limit = 24;
        selected = indexes[start] ?? -1;
        returnTo = undefined;
        draw();
        root.querySelector<HTMLButtonElement>("[aria-pressed=true]")?.focus();
      };
      earlier.push(previous);
    }
    const more = text("button", "Show more captured records");
    more.type = "button";
    more.hidden = start + limit >= indexes.length;
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
      ...earlier,
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

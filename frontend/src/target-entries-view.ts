import type { TgwTargetRequest, TgwTargetResponse, VpcSubnetLookupResult } from "./generated";
import { text } from "./view";

export type SavedTargetLookup = (query: TgwTargetRequest) => Promise<TgwTargetResponse | undefined>;
export type TargetContext = {
  topologyId: string;
  completedAt: string;
  gatewayId: string;
  attachmentIds: readonly string[];
  destination: string;
};
const scopeError = "Target response did not match the requested saved network/attachment scope";
const caveat =
  "All declared subnet entries; traffic AZ is not inferred. References only; NAT/IGW health, return path and connectivity remain untested.";
function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error(scopeError);
  return value;
}
function entryDescription(value: VpcSubnetLookupResult): string {
  switch (value.status) {
    case "association_unresolved":
      return `Target association unresolved: ${nonempty(value.reason)}`;
    case "unresolved":
      return `Target entry unresolved: ${nonempty(value.reason)}`;
    case "reported": {
      const table = nonempty(value.route_table_id);
      if (value.source !== "implicit_main" && value.source !== "explicit_subnet") throw new Error(scopeError);
      const entry = value.lookup;
      switch (entry.status) {
        case "unresolved":
          return `Table ${table} (${value.source}): target entry unresolved: ${nonempty(entry.reason)}`;
        case "reported_blackhole":
          return `Reported target blackhole: ${nonempty(entry.destination_cidr)} · table ${table} (${value.source})`;
        case "reported_route": {
          const target = entry.target;
          if (!["local", "transit_gateway", "nat_gateway", "internet_gateway"].includes(target.kind))
            throw new Error(scopeError);
          const reference = target.kind === "local" ? "local" : `${target.kind} ${nonempty(target.id)}`;
          return `Reported target entry: ${nonempty(entry.destination_cidr)} → ${reference} · table ${table} (${value.source})`;
        }
        default:
          throw new Error(scopeError);
      }
    }
    default:
      throw new Error(scopeError);
  }
}
export function renderTargetEntries(
  context: TargetContext,
  index: number,
  lookup: SavedTargetLookup,
  isCurrent: () => boolean,
): HTMLFieldSetElement {
  const expected = { ...context, attachmentIds: context.attachmentIds.map(nonempty) };
  for (const value of [expected.topologyId, expected.completedAt, expected.gatewayId, expected.destination])
    nonempty(value);
  if (
    !expected.attachmentIds.length ||
    new Set(expected.attachmentIds).size !== expected.attachmentIds.length
  )
    throw new Error(scopeError);
  const root = document.createElement("fieldset");
  root.dataset.targetEntries = "";
  root.append(text("legend", "Inspect a reported target attachment (saved evidence only)"));
  const label = text("label", "Reported TGW target attachment");
  const select = document.createElement("select");
  select.id = `aws-target-attachment-${index}`;
  label.htmlFor = select.id;
  // Not native-required: this fieldset belongs to the source form, whose resubmit must stay usable.
  select.setAttribute("aria-required", "true");
  const blank = text("option", "Select a reported attachment reference");
  blank.value = "";
  select.append(blank);
  for (const id of expected.attachmentIds) {
    const option = text("option", id);
    option.value = id;
    select.append(option);
  }
  const button = text("button", "Inspect all saved target subnet entries");
  button.type = "button";
  const output = text("p", caveat);
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");
  root.append(label, select, button, output);
  let generation = 0;
  select.onchange = () => {
    generation++;
    button.disabled = select.disabled = false;
    output.textContent = `Selection changed; run another saved lookup. ${caveat}`;
  };
  button.onclick = () => {
    if (button.disabled) return;
    if (!isCurrent()) {
      output.textContent = `Target lookup discarded; source view or inputs changed. ${caveat}`;
      return;
    }
    if (!expected.attachmentIds.includes(select.value)) {
      output.textContent = `Select a reported target attachment. ${caveat}`;
      return;
    }
    const query = {
      transit_gateway_id: expected.gatewayId,
      target_attachment_id: select.value,
      destination: expected.destination,
    };
    const version = ++generation;
    const current = () =>
      isCurrent() && version === generation && select.value === query.target_attachment_id;
    button.disabled = select.disabled = true;
    output.textContent = "Reading saved target subnet entries…";
    void (async () => {
      try {
        const value = await lookup(query);
        if (!current()) return;
        if (!value) {
          output.textContent = `Target lookup discarded; source view or inputs changed. ${caveat}`;
          return;
        }
        if (value.topology_id !== expected.topologyId) {
          output.textContent = `Snapshot changed; refresh source/network diagnostics before combining observations. ${caveat}`;
          return;
        }
        if (
          value.completed_at !== expected.completedAt ||
          value.transit_gateway_id !== query.transit_gateway_id ||
          value.target_attachment_id !== query.target_attachment_id ||
          value.destination !== query.destination ||
          value.az_selection !== "not_inferred" ||
          value.execution_enabled !== false ||
          value.connectivity_tested !== false
        )
          throw new Error(scopeError);
        let detail: string;
        switch (value.result.status) {
          case "unresolved":
            detail = `Target scope unresolved: ${nonempty(value.result.reason)}`;
            break;
          case "reported_subnets": {
            nonempty(value.result.vpc_id);
            const rows = value.result.subnets;
            if (!Array.isArray(rows) || !rows.length || rows.length > 32) throw new Error(scopeError);
            const ids = new Set<string>(),
              zones = new Set<string>();
            const descriptions = rows.map((row) => {
              const id = nonempty(row.subnet_id),
                zone = nonempty(row.az_id);
              if (ids.has(id) || zones.has(zone)) throw new Error(scopeError);
              ids.add(id);
              zones.add(zone);
              return `Saved target subnet ${id} · AZ ID ${zone}: ${entryDescription(row.lookup)}`;
            });
            detail = `VPC ${value.result.vpc_id}. ${descriptions.join(". ")}`;
            break;
          }
          default:
            throw new Error(scopeError);
        }
        output.textContent = `${detail}. Network observation ${expected.topologyId}, completed ${value.completed_at}. ${caveat}`;
      } catch (error) {
        if (current())
          output.textContent = `${error instanceof Error ? error.message : "Saved target lookup failed"}. ${caveat}`;
      } finally {
        if (version === generation) {
          if (!current())
            output.textContent = `Inputs or source view changed; run another saved lookup. ${caveat}`;
          button.disabled = select.disabled = false;
        }
      }
    })();
  };
  return root;
}

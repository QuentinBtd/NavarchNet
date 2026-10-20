import type {
  RouteTableSelection,
  TgwLookupResult,
  TgwSourceRequest,
  TgwSourceResponse,
  TgwTargetRequest,
  TgwTargetResponse,
  VerifiedAccount,
  VpcSubnetLookupResult,
} from "./generated";
import { renderTargetEntries } from "./target-entries-view";
import { text } from "./view";

export type SavedSourceHandoff = (query: TgwSourceRequest) => Promise<TgwSourceResponse | undefined>;
export type SavedNetworkTargetLookup = (
  networkAccountId: string,
  query: TgwTargetRequest,
) => Promise<TgwTargetResponse | undefined>;
const scopeError = "Lookup response did not match the requested saved source/network scope";
const caveat =
  "Independent saved observations, not a validated path. Target health, attachment-subnet/return routes and connectivity remain untested.";
function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error(scopeError);
  return value;
}
function sourceDescription(source: VpcSubnetLookupResult, selection: RouteTableSelection): string {
  switch (source.status) {
    case "association_unresolved":
      if (selection.status !== "unresolved" || source.reason !== selection.reason)
        throw new Error(scopeError);
      return `Source association unresolved: ${nonempty(source.reason)}`;
    case "unresolved":
      return `Source unresolved: ${nonempty(source.reason)}`;
    case "reported": {
      if (
        selection.status !== "selected" ||
        source.route_table_id !== selection.route_table_id ||
        source.source !== selection.source
      )
        throw new Error(scopeError);
      const entry = source.lookup;
      switch (entry.status) {
        case "unresolved":
          return `Source unresolved: ${nonempty(entry.reason)}`;
        case "reported_blackhole":
          return `Reported source blackhole: ${nonempty(entry.destination_cidr)}`;
        case "reported_route": {
          const target = entry.target;
          if (!["local", "transit_gateway", "nat_gateway", "internet_gateway"].includes(target.kind))
            throw new Error(scopeError);
          const id = target.kind === "local" ? "" : ` ${nonempty(target.id)}`;
          return `Source table ${source.route_table_id} (${source.source}): ${nonempty(entry.destination_cidr)} → ${target.kind}${id}`;
        }
        default:
          throw new Error(scopeError);
      }
    }
    default:
      throw new Error(scopeError);
  }
}
function tableDescription(lookup: TgwLookupResult): string {
  switch (lookup.status) {
    case "reported_blackhole":
      return `Reported TGW blackhole: ${nonempty(lookup.destination_cidr)}`;
    case "unresolved":
      return `TGW entry unresolved: ${nonempty(lookup.reason)}`;
    case "reported_forward":
      if (!Array.isArray(lookup.attachment_ids) || !lookup.attachment_ids.length) throw new Error(scopeError);
      return `Reported TGW entry: ${nonempty(lookup.destination_cidr)} → ${lookup.attachment_ids.map(nonempty).join(", ")}`;
    default:
      throw new Error(scopeError);
  }
}
export function renderSourceHandoff(
  topologyId: string,
  subnetId: string,
  selection: RouteTableSelection,
  index: number,
  accounts: Pick<VerifiedAccount, "id" | "name" | "region">[],
  lookup: SavedSourceHandoff,
  lookupTarget?: SavedNetworkTargetLookup,
): HTMLFormElement {
  const form = document.createElement("form");
  form.dataset.sourceHandoff = subnetId;
  const networkLabel = text("label", "Network account / region (saved observation)");
  const network = document.createElement("select");
  network.id = `aws-source-network-${index}`;
  network.required = true;
  networkLabel.htmlFor = network.id;
  const blank = text("option", "Select account / region");
  blank.value = "";
  network.append(blank);
  for (const account of accounts) {
    const option = text("option", `${account.name} · ${account.region}`);
    option.value = account.id;
    network.append(option);
  }
  const label = text("label", "Destination IP (source-to-TGW candidate)");
  const input = document.createElement("input");
  input.id = `aws-source-destination-${index}`;
  input.required = true;
  input.maxLength = 64;
  input.placeholder = "203.0.113.1";
  label.htmlFor = input.id;
  const submit = text("button", "Inspect saved ingress candidate");
  submit.type = "submit";
  const output = text("p", caveat);
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");
  form.append(networkLabel, network, label, input, submit, output);
  let generation = 0;
  let target: HTMLFieldSetElement | undefined;
  const changed = () => {
    generation++;
    submit.disabled = network.disabled = input.disabled = false;
    target?.remove();
    target = undefined;
    output.textContent = `Inputs changed; run another saved lookup. ${caveat}`;
  };
  input.oninput = input.onchange = changed;
  network.onchange = changed;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    if (!accounts.some((account) => account.id === network.value)) {
      output.textContent = `Select a saved network account. ${caveat}`;
      return;
    }
    const query = { network_account_id: network.value, subnet_id: subnetId, destination: input.value };
    const version = ++generation;
    target?.remove();
    target = undefined;
    const current = () =>
      version === generation &&
      network.value === query.network_account_id &&
      input.value === query.destination;
    submit.disabled = network.disabled = input.disabled = true;
    output.textContent = "Reading saved source and network observations…";
    void (async () => {
      try {
        const value = await lookup(query);
        if (!current()) return;
        if (!value) {
          output.textContent = `Lookup discarded; inputs, view or session changed. ${caveat}`;
          return;
        }
        if (value.source_topology_id !== topologyId) {
          output.textContent = `Snapshot changed; refresh the saved source observation. ${caveat}`;
          return;
        }
        if (
          value.network_account_id !== query.network_account_id ||
          value.subnet_id !== subnetId ||
          value.destination !== query.destination ||
          value.execution_enabled !== false ||
          value.connectivity_tested !== false
        )
          throw new Error(scopeError);
        nonempty(value.network_topology_id);
        for (const timestamp of [value.source_completed_at, value.network_completed_at])
          if (!/^\d+$/.test(nonempty(timestamp))) throw new Error(scopeError);
        const source = value.result.source;
        const description = sourceDescription(source, selection);
        const handoff = value.result.handoff;
        let detail: string;
        switch (handoff.status) {
          case "reported_candidate":
            if (
              source.status !== "reported" ||
              source.lookup.status !== "reported_route" ||
              source.lookup.target.kind !== "transit_gateway" ||
              source.lookup.target.id !== handoff.transit_gateway_id
            )
              throw new Error(scopeError);
            detail = `Reported ingress candidate: ${nonempty(handoff.transit_gateway_id)} · attachment ${nonempty(handoff.ingress_attachment_id)} · attachment subnet ${nonempty(handoff.attachment_subnet_id)} · AZ ID ${nonempty(handoff.az_id)} · table ${nonempty(handoff.route_table_id)}. ${tableDescription(handoff.lookup)}`;
            break;
          case "ingress_unresolved":
          case "unresolved":
            detail = `Ingress unresolved: ${nonempty(handoff.reason)}`;
            break;
          default:
            throw new Error(scopeError);
        }
        output.textContent = `${description}. ${detail}. Source observation ${topologyId}, completed ${value.source_completed_at}; network observation ${value.network_topology_id}, completed ${value.network_completed_at}. ${caveat}`;
        if (
          lookupTarget &&
          handoff.status === "reported_candidate" &&
          handoff.lookup.status === "reported_forward"
        ) {
          target = renderTargetEntries(
            {
              topologyId: value.network_topology_id,
              completedAt: value.network_completed_at,
              gatewayId: handoff.transit_gateway_id,
              attachmentIds: handoff.lookup.attachment_ids,
              destination: query.destination,
            },
            index,
            (targetQuery) => lookupTarget(value.network_account_id, targetQuery),
            current,
          );
          form.append(target);
        }
      } catch (error) {
        if (current())
          output.textContent = `${error instanceof Error ? error.message : "Saved ingress lookup failed"}. ${caveat}`;
      } finally {
        if (version === generation) {
          if (!current()) output.textContent = `Inputs changed; run another saved lookup. ${caveat}`;
          submit.disabled = network.disabled = input.disabled = false;
        }
      }
    })();
  };
  return form;
}

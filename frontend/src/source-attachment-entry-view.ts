import type { AwsTopology, RouteTableSelection, SubnetRouteTable, VpcSubnetLookupResult } from "./generated";
import { text } from "./view";
import type { SavedVpcLookup } from "./vpc-lookup-view";

export type SourceVpcContext = {
  snapshot: Pick<
    AwsTopology,
    "id" | "account_id" | "completed_at" | "execution_enabled" | "connectivity_tested"
  >;
  subnetRouteTables: readonly SubnetRouteTable[];
  lookup: SavedVpcLookup;
};
type AttachmentParent = {
  topologyId: string;
  completedAt: string;
  sourceSubnetId: string;
  outboundDestination: string;
  attachmentSubnetId: string;
  sourceSelection: RouteTableSelection;
};
const scopeError = "Attachment entry response did not match the requested saved source scope";
const caveat =
  "One operator-supplied IP in a reported candidate subnet table; not a validated return path. Receiving traffic AZ, host membership, whole-CIDR coverage, target health and connectivity are not established.";
function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) throw new Error(scopeError);
  return value;
}
function selectionValid(selection: RouteTableSelection): void {
  if (selection?.status === "selected") {
    nonempty(selection.route_table_id);
    if (!["explicit_subnet", "implicit_main"].includes(selection.source)) throw new Error(scopeError);
  } else if (selection?.status === "unresolved") nonempty(selection.reason);
  else throw new Error(scopeError);
}
function describe(value: VpcSubnetLookupResult, selection: RouteTableSelection): string {
  switch (value.status) {
    case "association_unresolved":
      if (selection.status !== "unresolved" || value.reason !== selection.reason) throw new Error(scopeError);
      return `Attachment table association unresolved: ${nonempty(value.reason)}`;
    case "unresolved":
      return `Attachment entry unresolved: ${nonempty(value.reason)}`;
    case "reported": {
      if (
        selection.status !== "selected" ||
        value.route_table_id !== selection.route_table_id ||
        value.source !== selection.source
      )
        throw new Error(scopeError);
      const table = `table ${value.route_table_id} (${value.source})`;
      const entry = value.lookup;
      switch (entry.status) {
        case "unresolved":
          return `${table}: attachment entry unresolved: ${nonempty(entry.reason)}`;
        case "reported_blackhole":
          return `Reported attachment-subnet blackhole: ${nonempty(entry.destination_cidr)} · ${table}`;
        case "reported_route": {
          const target = entry.target;
          if (!["local", "transit_gateway", "nat_gateway", "internet_gateway"].includes(target.kind))
            throw new Error(scopeError);
          const reference = target.kind === "local" ? "VPC local" : `${target.kind} ${nonempty(target.id)}`;
          return `Reported attachment-subnet entry: ${nonempty(entry.destination_cidr)} → ${reference} · ${nonempty(entry.origin)} · ${table}`;
        }
        default:
          throw new Error(scopeError);
      }
    }
    default:
      throw new Error(scopeError);
  }
}
export function renderSourceAttachmentEntry(
  context: SourceVpcContext,
  parent: AttachmentParent,
  index: number,
  isCurrent: () => boolean,
): HTMLFieldSetElement {
  const snapshot = { ...context.snapshot };
  const expected = { ...parent, sourceSelection: { ...parent.sourceSelection } };
  const lookup = context.lookup;
  for (const value of [
    snapshot.id,
    snapshot.account_id,
    snapshot.completed_at,
    expected.topologyId,
    expected.completedAt,
    expected.sourceSubnetId,
    expected.outboundDestination,
    expected.attachmentSubnetId,
  ])
    nonempty(value);
  if (
    snapshot.id !== expected.topologyId ||
    snapshot.completed_at !== expected.completedAt ||
    !/^\d+$/.test(snapshot.completed_at) ||
    snapshot.execution_enabled !== false ||
    snapshot.connectivity_tested !== false ||
    !Array.isArray(context.subnetRouteTables)
  )
    throw new Error(scopeError);
  const sources = context.subnetRouteTables.filter((row) => row?.subnet_id === expected.sourceSubnetId);
  const candidates = context.subnetRouteTables.filter(
    (row) => row?.subnet_id === expected.attachmentSubnetId,
  );
  const source = sources[0],
    candidate = candidates[0];
  if (
    sources.length !== 1 ||
    candidates.length !== 1 ||
    !source ||
    !candidate ||
    nonempty(source.vpc_id) !== nonempty(candidate.vpc_id)
  )
    throw new Error(scopeError);
  selectionValid(source.selection);
  selectionValid(candidate.selection);
  selectionValid(expected.sourceSelection);
  if (
    source.selection.status !== "selected" ||
    expected.sourceSelection.status !== "selected" ||
    source.selection.route_table_id !== expected.sourceSelection.route_table_id ||
    source.selection.source !== expected.sourceSelection.source
  )
    throw new Error(scopeError);
  const selection = { ...candidate.selection };
  const root = document.createElement("fieldset");
  root.dataset.sourceAttachmentEntry = expected.attachmentSubnetId;
  root.append(
    text("legend", "Inspect saved source attachment-subnet table (hypothetical delivery into source VPC)"),
    text(
      "p",
      `Source registration ${snapshot.account_id}, observation ${snapshot.id}, completed ${snapshot.completed_at} (inherited immutable snapshot context). Original outbound destination: ${expected.outboundDestination}; candidate subnet: ${expected.attachmentSubnetId}. This does not select a return ingress or receiving AZ.`,
    ),
  );
  const label = text("label", "Operator-supplied destination IP (separate point inspection)");
  const input = document.createElement("input");
  input.id = `aws-source-attachment-point-${index}`;
  input.maxLength = 64;
  input.setAttribute("aria-required", "true");
  label.htmlFor = input.id;
  // A nested required field or Enter submit must not prevent/trigger an independent parent refresh.
  input.onkeydown = (event) => {
    if (event.key === "Enter") event.preventDefault();
  };
  const button = text("button", "Inspect saved source attachment-subnet entry");
  button.type = "button";
  const output = text("p", caveat);
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");
  root.append(label, input, button, output);
  let generation = 0;
  input.oninput = input.onchange = () => {
    generation++;
    button.disabled = input.disabled = false;
    output.textContent = `Inputs changed; run another saved lookup. ${caveat}`;
  };
  button.onclick = () => {
    if (button.disabled || !isCurrent()) return;
    if (!input.value || input.value.length > 64) {
      output.textContent = `Enter one destination IP (maximum 64 characters). ${caveat}`;
      return;
    }
    const query = { subnet_id: expected.attachmentSubnetId, destination: input.value };
    const version = ++generation;
    const current = () => isCurrent() && version === generation && input.value === query.destination;
    button.disabled = input.disabled = true;
    output.textContent = "Reading saved attachment-subnet observation…";
    void (async () => {
      try {
        const value = await lookup(query);
        if (!current()) return;
        if (!value) {
          output.textContent = `Lookup discarded; source view or inputs changed. ${caveat}`;
          return;
        }
        if (value.topology_id !== snapshot.id) {
          output.textContent = `Snapshot changed; refresh the saved source candidate before combining observations. ${caveat}`;
          return;
        }
        if (
          value.subnet_id !== query.subnet_id ||
          value.destination !== query.destination ||
          value.execution_enabled !== false ||
          value.connectivity_tested !== false
        )
          throw new Error(scopeError);
        const description = describe(value.result, selection);
        output.textContent = `Operator destination ${query.destination}: ${description}. ${caveat}`;
      } catch (error) {
        if (current())
          output.textContent = `${error instanceof Error ? error.message : "Saved attachment lookup failed"}. ${caveat}`;
      } finally {
        if (version === generation) {
          if (!current()) output.textContent = `Inputs changed; run another saved lookup. ${caveat}`;
          button.disabled = input.disabled = false;
        }
      }
    })();
  };
  return root;
}

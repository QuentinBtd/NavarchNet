import type { RouteTableSelection, VpcLookupRequest, VpcLookupResponse, VpcRouteTarget } from "./generated";
import { type NatReferenceParent, renderNatReference } from "./nat-reference-view";
import { text } from "./view";

export type SavedVpcLookup = (query: VpcLookupRequest) => Promise<VpcLookupResponse | undefined>;
const scopeError = "Lookup response did not match the requested saved subnet scope";
function targetDescription(target: VpcRouteTarget): string {
  if (target.kind !== "local" && (typeof target.id !== "string" || !target.id)) throw new Error(scopeError);
  switch (target.kind) {
    case "local":
      return "VPC local";
    case "transit_gateway":
      return `transit gateway: ${target.id}`;
    case "nat_gateway":
      return `NAT gateway: ${target.id}`;
    case "internet_gateway":
      return `internet gateway: ${target.id}`;
    default:
      throw new Error(scopeError);
  }
}
export function renderVpcLookup(
  topologyId: string,
  subnetId: string,
  selection: RouteTableSelection,
  index: number,
  lookup: SavedVpcLookup,
  natReference?: NatReferenceParent,
): HTMLFormElement {
  const form = document.createElement("form");
  form.dataset.vpcRouteLookup = subnetId;
  const label = text("label", "Destination IP (saved subnet route lookup)");
  const input = document.createElement("input");
  input.id = `aws-vpc-lookup-${index}`;
  input.required = true;
  input.maxLength = 64;
  input.placeholder = "203.0.113.1 or 2001:db8::1";
  label.htmlFor = input.id;
  const submit = text("button", "Look up saved subnet route");
  submit.type = "submit";
  const caveat = "Saved entry only; target health and connectivity remain untested.";
  const output = text("p", caveat);
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");
  form.append(label, input, submit, output);
  let generation = 0;
  let child: HTMLFieldSetElement | undefined;
  const retireChild = () => {
    child?.remove();
    child?.replaceChildren();
    child = undefined;
  };
  const changed = () => {
    generation++;
    retireChild();
    submit.disabled = input.disabled = false;
    output.textContent = `Inputs changed; run another saved lookup. ${caveat}`;
  };
  input.oninput = input.onchange = changed;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (submit.disabled || (natReference && !natReference.isCurrent())) return;
    const query = { subnet_id: subnetId, destination: input.value };
    const version = ++generation;
    retireChild();
    const current = () =>
      version === generation &&
      input.value === query.destination &&
      (!natReference || natReference.isCurrent());
    submit.disabled = true;
    input.disabled = true;
    output.textContent = "Reading saved subnet observation…";
    void (async () => {
      try {
        const value = await lookup(query);
        if (!current()) return;
        if (!value) {
          output.textContent = "Lookup discarded; view or session changed.";
          return;
        }
        if (value.topology_id !== topologyId) {
          output.textContent = "Snapshot changed; refresh the saved observation before another lookup.";
          return;
        }
        if (
          value.subnet_id !== subnetId ||
          value.destination !== query.destination ||
          value.execution_enabled !== false ||
          value.connectivity_tested !== false
        )
          throw new Error(scopeError);
        const result = value.result;
        let description: string;
        switch (result.status) {
          case "reported": {
            if (
              selection.status !== "selected" ||
              result.route_table_id !== selection.route_table_id ||
              result.source !== selection.source
            )
              throw new Error(scopeError);
            const entry = result.lookup;
            switch (entry.status) {
              case "reported_route":
                description = `Reported subnet entry: ${value.destination} → ${entry.destination_cidr} · ${targetDescription(entry.target)} · ${entry.origin}`;
                break;
              case "reported_blackhole":
                description = `Reported subnet blackhole: ${value.destination} → ${entry.destination_cidr}`;
                break;
              case "unresolved":
                description = `Unresolved: ${entry.reason}`;
                break;
              default:
                throw new Error(scopeError);
            }
            break;
          }
          case "association_unresolved":
            if (selection.status !== "unresolved" || result.reason !== selection.reason)
              throw new Error(scopeError);
            description = `Table association unresolved: ${result.reason}`;
            break;
          case "unresolved":
            description = `Unresolved: ${result.reason}`;
            break;
          default:
            throw new Error(scopeError);
        }
        output.textContent = `${description}. ${caveat}`;
        if (
          natReference &&
          result.status === "reported" &&
          result.lookup.status === "reported_route" &&
          result.lookup.target.kind === "nat_gateway"
        ) {
          if (natReference.snapshot.id !== topologyId) throw new Error(scopeError);
          child = renderNatReference(natReference, query, result, current);
          form.append(child);
        }
      } catch (error) {
        if (current())
          output.textContent = error instanceof Error ? error.message : "Saved subnet lookup failed";
      } finally {
        if (version === generation) {
          if (!current()) output.textContent = `Inputs changed; run another saved lookup. ${caveat}`;
          submit.disabled = input.disabled = false;
        }
      }
    })();
  };
  return form;
}

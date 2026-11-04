import type {
  AwsTopology,
  NatReferenceResponse,
  NatReferenceScope,
  VpcLookupRequest,
  VpcSubnetLookupResult,
} from "./generated";
import { renderNatMetadata, type SavedNatSnapshot } from "./nat-metadata-view";
import { text } from "./view";

export type SavedNatReferenceLookup = (query: VpcLookupRequest) => Promise<NatReferenceResponse | undefined>;
export type NatReferenceParent = Readonly<{
  snapshot: SavedNatSnapshot & Pick<AwsTopology, "account_id" | "aws_account_id">;
  subnetVpcId: string | null;
  lookup: SavedNatReferenceLookup;
  isCurrent: () => boolean;
}>;
const scopeError = "NAT reference response did not match the original saved entry and snapshot";
function entryFields(entry: VpcSubnetLookupResult): string[] {
  if (
    entry?.status !== "reported" ||
    !["explicit_subnet", "implicit_main"].includes(entry.source) ||
    entry.lookup?.status !== "reported_route" ||
    entry.lookup.target?.kind !== "nat_gateway"
  )
    throw new Error(scopeError);
  const fields = [
    entry.route_table_id,
    entry.source,
    entry.lookup.destination_cidr,
    entry.lookup.origin,
    entry.lookup.target.id,
  ];
  if (!fields.every((field) => typeof field === "string" && field.length > 0)) throw new Error(scopeError);
  return fields;
}
function literalScope(observed: string | null, expected: string | null): NatReferenceScope {
  if (
    !(observed === null || typeof observed === "string") ||
    !(expected === null || typeof expected === "string")
  )
    throw new Error(scopeError);
  return observed === null || expected === null
    ? "not_reported"
    : observed === expected
      ? "reported_same"
      : "reported_different";
}
export function renderNatReference(
  parent: NatReferenceParent,
  originalQuery: Readonly<VpcLookupRequest>,
  originalEntry: VpcSubnetLookupResult,
  isCurrent: () => boolean,
): HTMLFieldSetElement {
  const snapshot = { ...parent.snapshot };
  const subnetVpcId = parent.subnetVpcId;
  const query = { ...originalQuery };
  const original = entryFields(originalEntry);
  if (
    ![
      snapshot.id,
      snapshot.account_id,
      snapshot.aws_account_id,
      snapshot.completed_at,
      query.subnet_id,
      query.destination,
    ].every((field) => typeof field === "string" && field.length > 0) ||
    snapshot.execution_enabled !== false ||
    snapshot.connectivity_tested !== false ||
    !(subnetVpcId === null || typeof subnetVpcId === "string")
  )
    throw new Error(scopeError);
  const panel = document.createElement("fieldset");
  panel.dataset.natReference = "";
  const action = text("button", "Inspect referenced saved NAT record");
  action.type = "button";
  const status = text(
    "p",
    "Explicit saved record inspection only; no NAT health, used egress, selected AZ or full path is inferred.",
  );
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const host = document.createElement("div");
  panel.append(text("legend", "Saved NAT reference"), action, status, host);
  let generation = 0;
  action.onclick = () => {
    if (action.disabled || !isCurrent() || !parent.isCurrent()) return;
    const version = ++generation;
    const current = () => version === generation && isCurrent() && parent.isCurrent();
    action.disabled = true;
    host.replaceChildren();
    status.textContent = "Reading saved NAT reference…";
    void (async () => {
      try {
        const value = await parent.lookup({ ...query });
        if (!current()) return;
        if (!value) {
          status.textContent = "NAT reference discarded; view or session changed.";
          return;
        }
        if (
          value.account_id !== snapshot.account_id ||
          value.topology_id !== snapshot.id ||
          value.completed_at !== snapshot.completed_at ||
          value.subnet_id !== query.subnet_id ||
          value.destination !== query.destination ||
          value.reference_only !== true ||
          value.execution_enabled !== false ||
          value.connectivity_tested !== false
        )
          throw new Error(scopeError);
        const fields = entryFields(value.result.subnet_lookup);
        if (fields.some((field, index) => field !== original[index])) throw new Error(scopeError);
        const reference = value.result.reference;
        if (reference.status === "unresolved") {
          if (
            ![
              "no_reported_nat_reference",
              "missing_or_ambiguous_record",
              "incomplete_observation",
              "unsupported_region",
            ].includes(reference.reason)
          )
            throw new Error(scopeError);
          status.textContent = `Saved NAT reference unresolved: ${reference.reason}. Original subnet entry is unchanged; no usable path is established.`;
          return;
        }
        if (reference.status !== "reported_record") throw new Error(scopeError);
        const resource = structuredClone(reference.resource);
        if (
          resource.kind !== "nat_gateway" ||
          resource.id !== original[4] ||
          ![resource.state, resource.availability_mode].every(
            (field) => field === null || typeof field === "string",
          ) ||
          reference.owner_scope !== literalScope(resource.owner_account_id, snapshot.aws_account_id) ||
          reference.vpc_scope !== literalScope(resource.vpc_id, subnetVpcId)
        )
          throw new Error(scopeError);
        host.append(
          text(
            "p",
            `Saved account: ${snapshot.account_id} · snapshot: ${snapshot.id} · completed: ${snapshot.completed_at}`,
          ),
          text(
            "p",
            `Subnet: ${query.subnet_id} · destination: ${query.destination} · original NAT reference: ${original[4]}`,
          ),
          text(
            "p",
            `Referenced saved NAT record: ${resource.id} · reported state: ${resource.state ?? "not reported"}`,
          ),
          text(
            "p",
            `Raw owner: ${resource.owner_account_id ?? "not reported"} · raw VPC: ${resource.vpc_id ?? "not reported"}`,
          ),
          text(
            "p",
            `Owner field vs saved AWS-account field: ${reference.owner_scope} · VPC field vs saved subnet VPC field: ${reference.vpc_scope}`,
          ),
          renderNatMetadata(resource, snapshot, current),
        );
        status.textContent =
          "Literal saved field comparisons only; not ownership, authority or routing validation. No NAT health, used egress, selected AZ or full path is inferred.";
      } catch (error) {
        if (current())
          status.textContent = error instanceof Error ? error.message : "Saved NAT reference failed";
      } finally {
        if (version === generation) {
          action.disabled = !current();
          if (!current()) {
            host.replaceChildren();
            status.textContent = "NAT reference retired; run another saved subnet lookup.";
          }
        }
      }
    })();
  };
  return panel;
}

import type { SourceHandoffCidrCoverage, SourceHandoffCidrQuery, VerifiedAccount } from "./generated";
import type { SourceCidrContext } from "./source-cidr-view";

// Shape and literal provenance checks only. The server owns partition/IP/predicate proof.
const mismatch = "CIDR response did not match the requested independent saved observations; refresh the view";
type Rule = (value: unknown) => boolean;
const string: Rule = (v) => typeof v === "string";
const nonempty: Rule = (v) => string(v) && (v as string).length > 0;
const boolean: Rule = (v) => typeof v === "boolean";
const disabled: Rule = (v) => v === false;
const timestamp: Rule = (v) => typeof v === "string" && /^\d+$/.test(v);
const integer: Rule = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const positive: Rule = (v) => integer(v) && (v as number) > 0;
const oneOf =
  (...values: unknown[]): Rule =>
  (v) =>
    values.includes(v);
const nullable =
  (rule: Rule): Rule =>
  (v) =>
    v === null || rule(v);
const array =
  (rule: Rule): Rule =>
  (v) => {
    if (!Array.isArray(v)) return false;
    for (let index = 0; index < v.length; index++) {
      if (!Object.hasOwn(v, index) || !rule(v[index])) return false;
    }
    return true;
  };
const record: Rule = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const map =
  (rule: Rule): Rule =>
  (v) =>
    record(v) && Object.values(v as object).every(rule);
const object =
  (fields: Record<string, Rule>, exact = false): Rule =>
  (v) =>
    record(v) &&
    Object.entries(fields).every(
      ([key, rule]) => Object.hasOwn(v as object, key) && rule((v as Record<string, unknown>)[key]),
    ) &&
    (!exact || Object.keys(v as object).length === Object.keys(fields).length);
const strings = array(string),
  optionalString = nullable(string);
const attachment = object({
  attachment_id: optionalString,
  resource_id: optionalString,
  resource_type: optionalString,
});
const link = object({
  attachment_id: optionalString,
  resource_id: optionalString,
  resource_type: optionalString,
  state: optionalString,
  route_table_announcement_id: optionalString,
});
const route = object({
  ipv4_destination: optionalString,
  ipv6_destination: optionalString,
  prefix_list_destination: optionalString,
  state: optionalString,
  origin: optionalString,
  targets: map(string),
});
const tgwRoute = object({
  destination_cidr: optionalString,
  prefix_list_id: optionalString,
  state: optionalString,
  route_type: optionalString,
  route_table_announcement_id: optionalString,
  attachments: array(attachment),
});
const association = object({
  state: optionalString,
  id: optionalString,
  subnet_id: optionalString,
  gateway_id: optionalString,
  main: boolean,
});
const address = object({
  allocation_id: optionalString,
  association_id: optionalString,
  network_interface_id: optionalString,
  public_ip: optionalString,
  private_ip: optionalString,
  az_name: optionalString,
  az_id: optionalString,
  is_primary: nullable(boolean),
  status: optionalString,
});
const resource = object({
  kind: oneOf(
    "vpc",
    "subnet",
    "route_table",
    "transit_gateway",
    "vpc_attachment",
    "nat_gateway",
    "internet_gateway",
    "elastic_ip",
    "transit_gateway_route_table",
    "ram_share",
    "ram_resource",
    "ram_principal",
    "ram_invitation",
  ),
  id: string,
  owner_account_id: optionalString,
  vpc_id: optionalString,
  subnet_id: optionalString,
  az_id: optionalString,
  state: optionalString,
  cidrs: strings,
  public_ips: strings,
  private_ips: strings,
  tags: map(string),
  routes: array(route),
  associations: array(association),
  tgw_associations: nullable(array(link)),
  tgw_propagations: nullable(array(link)),
  tgw_routes: nullable(array(tgwRoute)),
  related_ids: strings,
  connectivity_type: optionalString,
  availability_mode: optionalString,
  nat_gateway: nullable(object({ route_table_id: optionalString, addresses: nullable(array(address)) })),
  managed: boolean,
});
const metadata = {
  id: nonempty,
  account_id: nonempty,
  aws_account_id: nonempty,
  region: nonempty,
  started_at: timestamp,
  completed_at: timestamp,
  session_name: nonempty,
  request_ids: strings,
  limitations: strings,
  complete_for_supported_queries: boolean,
  execution_enabled: disabled,
  connectivity_tested: disabled,
};
const registration = object({
  id: nonempty,
  name: string,
  role_arn: nonempty,
  aws_account_id: nonempty,
  region: nonempty,
  verified_at: timestamp,
  verified_session_name: nonempty,
  execution_enabled: disabled,
});
const saved = object({
  registration,
  saved_row_id: nonempty,
  generation: positive,
  admitted_bytes: integer,
  topology: object({ ...metadata, resources: array(resource) }),
});
const unresolved = (status: string) => object({ status: oneOf(status), reason: nonempty });
const blackhole = object({ status: oneOf("reported_blackhole"), destination_cidr: nonempty });
const target: Rule = (v) =>
  object({ kind: oneOf("local") }, true)(v) ||
  object({ kind: oneOf("transit_gateway", "nat_gateway", "internet_gateway"), id: nonempty }, true)(v);
const vpcLookup: Rule = (v) =>
  unresolved("unresolved")(v) ||
  blackhole(v) ||
  object({ status: oneOf("reported_route"), destination_cidr: nonempty, origin: nonempty, target })(v);
const source: Rule = (v) =>
  unresolved("association_unresolved")(v) ||
  unresolved("unresolved")(v) ||
  object({
    status: oneOf("reported"),
    route_table_id: nonempty,
    source: oneOf("explicit_subnet", "implicit_main"),
    lookup: vpcLookup,
  })(v);
const tgwLookup: Rule = (v) =>
  unresolved("unresolved")(v) ||
  blackhole(v) ||
  object({
    status: oneOf("reported_forward"),
    destination_cidr: nonempty,
    route_type: nonempty,
    attachment_ids: (v) => array(nonempty)(v) && (v as unknown[]).length > 0,
  })(v);
const handoff: Rule = (v) =>
  unresolved("unresolved")(v) ||
  unresolved("ingress_unresolved")(v) ||
  object({
    status: oneOf("reported_candidate"),
    transit_gateway_id: nonempty,
    ingress_attachment_id: nonempty,
    attachment_subnet_id: nonempty,
    az_id: nonempty,
    route_table_id: nonempty,
    lookup: tgwLookup,
  })(v);
const cell = object({ start: nonempty, end_inclusive: nonempty, result: object({ source, handoff }) });
const queryShape = object(
  {
    source_account_id: nonempty,
    network_account_id: nonempty,
    subnet_id: nonempty,
    destination_cidr: nonempty,
  },
  true,
);
const originShape = object({
  cut_index: integer,
  edge: oneOf("query_start", "enter", "leave"),
  clipped: boolean,
  predicate: record,
});
const envelope = object({
  query: queryShape,
  source_saved: saved,
  network_saved: saved,
  segments: (v) => array(cell)(v) && (v as unknown[]).length > 0,
  origins: array(originShape),
  reference_only: (v) => v === true,
  partition_complete: (v) => v === true,
  execution_enabled: disabled,
  connectivity_tested: disabled,
  simultaneous_snapshots: disabled,
});
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((v, i) => same(v, right[i]));
  if (!record(left) || !record(right) || Array.isArray(left) || Array.isArray(right)) return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}
export type SourceCidrNetwork = Pick<VerifiedAccount, "id" | "aws_account_id" | "region">;
export function validateSourceCidr(
  value: SourceHandoffCidrCoverage,
  snapshot: SourceCidrContext,
  network: SourceCidrNetwork,
  query: SourceHandoffCidrQuery,
): void {
  const check = (ok: boolean) => {
    if (!ok) throw new Error(mismatch);
  };
  check(
    object(metadata)(snapshot) &&
      object({ id: nonempty, aws_account_id: nonempty, region: nonempty })(network) &&
      envelope(value),
  );
  check(same(value.query, query));
  for (const [capture, expected] of [
    [
      value.source_saved,
      { id: snapshot.account_id, aws_account_id: snapshot.aws_account_id, region: snapshot.region },
    ],
    [value.network_saved, network],
  ] as const) {
    const r = capture.registration,
      t = capture.topology;
    check(
      r.id === expected.id &&
        r.aws_account_id === expected.aws_account_id &&
        r.region === expected.region &&
        t.id === capture.saved_row_id &&
        t.account_id === r.id &&
        t.aws_account_id === r.aws_account_id &&
        t.region === r.region,
    );
  }
  for (const key of Object.keys(metadata) as (keyof SourceCidrContext)[])
    check(same(value.source_saved.topology[key], snapshot[key]));
  for (const segment of value.segments) {
    const { source, handoff } = segment.result;
    if (handoff.status === "reported_candidate")
      check(
        source.status === "reported" &&
          source.lookup.status === "reported_route" &&
          source.lookup.target.kind === "transit_gateway" &&
          source.lookup.target.id === handoff.transit_gateway_id,
      );
  }
  let queries = 0;
  for (const origin of value.origins) {
    check(origin.cut_index < value.segments.length);
    const p = origin.predicate;
    if (p.kind === "query") {
      check(
        object({ kind: oneOf("query") }, true)(p) &&
          origin.cut_index === 0 &&
          origin.edge === "query_start" &&
          origin.clipped === false,
      );
      queries++;
      continue;
    }
    check(
      (origin.edge === "enter" || origin.edge === "leave") &&
        (!origin.clipped || (origin.edge === "enter" && origin.cut_index === 0)) &&
        (origin.edge !== "leave" || origin.cut_index > 0),
    );
    if (p.kind === "vpc_service") {
      // Literal indexes from vpc_lookup::reserved_service_networks, not client IP math.
      check(object({ kind: oneOf("vpc_service"), policy_index: oneOf(0, 1) }, true)(p));
    } else if (p.kind === "source_vpc_route" || p.kind === "network_tgw_route") {
      check(object({ kind: oneOf(p.kind), resource_index: integer, route_index: integer }, true)(p));
      const sourceSide = p.kind === "source_vpc_route";
      const rows = (sourceSide ? value.source_saved : value.network_saved).topology.resources;
      const row = rows[p.resource_index];
      check(!!row && row.kind === (sourceSide ? "route_table" : "transit_gateway_route_table"));
      if (!row) throw new Error(mismatch);
      check(
        sourceSide
          ? p.route_index < row.routes.length
          : row.tgw_routes !== null && p.route_index < row.tgw_routes.length,
      );
    } else check(false);
  }
  check(queries === 1);
}

import type {
  RouteTableSelection,
  TopologyView,
  VpcCidrCoverageRequest,
  VpcCidrCoverageResponse,
  VpcSubnetLookupResult,
} from "./generated";
import { text } from "./view";

export type SavedVpcCidrCoverage = (
  query: VpcCidrCoverageRequest,
) => Promise<VpcCidrCoverageResponse | undefined>;
const mismatch = "CIDR response did not match the requested saved observation; refresh the view";
const caveat =
  "Complete saved-decision coverage, not usable connectivity, host membership, a return path, target health, selected AZ/egress or ownership. Unknown decisions remain unknown; no cloud calls or network probes.";
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value) throw new Error(mismatch);
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(mismatch);
}
// Structural JSON equality, not key-order equality or an implementation of routing/IP arithmetic.
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => same(value, right[index]))
    );
  const a = Object.keys(left).sort(),
    b = Object.keys(right).sort();
  return (
    same(a, b) &&
    a.every((key) => same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
  );
}
function resultValid(result: VpcSubnetLookupResult, selection: RouteTableSelection): void {
  switch (result?.status) {
    case "association_unresolved":
      if (selection.status !== "unresolved" || result.reason !== selection.reason) throw new Error(mismatch);
      nonempty(result.reason);
      return;
    case "unresolved":
      nonempty(result.reason);
      return;
    case "reported": {
      if (
        selection.status !== "selected" ||
        result.route_table_id !== selection.route_table_id ||
        result.source !== selection.source
      )
        throw new Error(mismatch);
      const entry = result.lookup;
      switch (entry?.status) {
        case "unresolved":
          nonempty(entry.reason);
          return;
        case "reported_blackhole":
          nonempty(entry.destination_cidr);
          return;
        case "reported_route": {
          nonempty(entry.destination_cidr);
          nonempty(entry.origin);
          const target = entry.target;
          if (
            !target ||
            !["local", "nat_gateway", "transit_gateway", "internet_gateway"].includes(target.kind)
          )
            throw new Error(mismatch);
          if (target.kind !== "local") nonempty(target.id);
          if (
            Object.keys(target).some(
              (key) => !["kind", ...(target.kind === "local" ? [] : ["id"])].includes(key),
            )
          )
            throw new Error(mismatch);
          return;
        }
        default:
          throw new Error(mismatch);
      }
    }
    default:
      throw new Error(mismatch);
  }
}
function batch(
  label: string,
  values: readonly unknown[],
  current: () => boolean,
  intervals = false,
): HTMLDetailsElement {
  const detail = document.createElement("details");
  detail.append(text("summary", `${label} (${values.length})`));
  let shown = 0,
    started = false;
  const list = document.createElement("ul"),
    count = text("p", ""),
    more = text("button", "Show more saved evidence");
  more.type = "button";
  const append = () => {
    if (!current()) return;
    const end = Math.min(shown + 50, values.length);
    for (; shown < end; shown++) {
      const item = text("li", JSON.stringify(values[shown]));
      if (intervals) item.dataset.vpcCidrInterval = "";
      list.append(item);
    }
    count.textContent = `Showing ${shown} of ${values.length} returned ${label.toLowerCase()}. Local display batches, not an AWS quota.`;
    more.hidden = shown === values.length;
  };
  more.onclick = append;
  detail.ontoggle = () => {
    if (!detail.open || started || !current()) return;
    started = true;
    detail.append(count, list, more);
    append();
  };
  return detail;
}
export function renderVpcCidrCoverage(
  view: TopologyView,
  subnetId: string,
  index: number,
  lookup: SavedVpcCidrCoverage,
  isCurrent: () => boolean,
): HTMLDetailsElement {
  const detail = document.createElement("details");
  detail.dataset.vpcCidrInspector = subnetId;
  detail.append(text("summary", "Inspect saved destination-CIDR decisions"));
  let initialized = false;
  detail.ontoggle = () => {
    if (!detail.open || initialized || !isCurrent()) return;
    initialized = true;
    try {
      initialize();
    } catch {
      detail.append(
        text(
          "p",
          "CIDR inspection unavailable: missing or ambiguous saved context. Existing diagnostics remain available.",
        ),
      );
    }
  };
  function initialize() {
    const source = view.topology;
    strings(source.limitations);
    strings(source.request_ids);
    const snapshot = {
      id: source.id,
      account_id: source.account_id,
      aws_account_id: source.aws_account_id,
      region: source.region,
      completed_at: source.completed_at,
      complete_for_supported_queries: source.complete_for_supported_queries,
      limitations: [...source.limitations],
      request_ids: [...source.request_ids],
    };
    for (const field of [
      snapshot.id,
      snapshot.account_id,
      snapshot.aws_account_id,
      snapshot.region,
      snapshot.completed_at,
      subnetId,
    ])
      nonempty(field);
    if (
      source.execution_enabled !== false ||
      source.connectivity_tested !== false ||
      typeof snapshot.complete_for_supported_queries !== "boolean" ||
      !/^\d+$/.test(snapshot.completed_at) ||
      new TextEncoder().encode(subnetId).length > 2048 ||
      /\p{Cc}/u.test(subnetId)
    )
      throw new Error(mismatch);
    strings(snapshot.limitations);
    strings(snapshot.request_ids);
    const rows = view.subnet_route_tables.filter((row) => row.subnet_id === subnetId);
    const subnets = source.resources.filter((row) => row.id === subnetId && row.kind === "subnet");
    const selectedRow = rows[0],
      subnet = subnets[0];
    if (
      !selectedRow ||
      !subnet ||
      rows.length !== 1 ||
      subnets.length !== 1 ||
      selectedRow.vpc_id !== subnet.vpc_id
    )
      throw new Error(mismatch);
    const selection: RouteTableSelection = { ...selectedRow.selection };
    if (selection.status === "selected") {
      nonempty(selection.route_table_id);
      if (!["explicit_subnet", "implicit_main"].includes(selection.source)) throw new Error(mismatch);
    } else if (selection.status === "unresolved") nonempty(selection.reason);
    else throw new Error(mismatch);
    const tables = source.resources
      .map((resource, at) => ({ resource, at }))
      .filter(
        ({ resource }) =>
          selection.status === "selected" &&
          resource.kind === "route_table" &&
          resource.id === selection.route_table_id,
      );
    const table =
      tables.length === 1 ? (JSON.parse(JSON.stringify(tables[0])) as (typeof tables)[number]) : undefined;
    const fieldset = document.createElement("fieldset");
    fieldset.dataset.vpcCidrCoverage = subnetId;
    const label = text("label", "Destination CIDR (saved decisions)"),
      input = document.createElement("input");
    input.id = `aws-vpc-cidr-${index}`;
    input.maxLength = 64;
    label.htmlFor = input.id;
    input.placeholder = "10.10.0.0/16 or 2001:db8::/32";
    input.onkeydown = (event) => {
      if (event.key === "Enter") event.preventDefault();
    };
    const button = text("button", "Inspect saved CIDR decisions");
    button.type = "button";
    const status = text("p", caveat);
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const evidence = document.createElement("div");
    fieldset.append(
      text("legend", "Saved destination-CIDR decisions"),
      label,
      input,
      button,
      status,
      evidence,
    );
    detail.append(fieldset);
    let generation = 0;
    const changed = () => {
      if (!isCurrent()) return;
      generation++;
      evidence.replaceChildren();
      button.disabled = input.disabled = false;
      status.textContent = `Inputs changed; run another saved CIDR inspection. ${caveat}`;
    };
    input.oninput = input.onchange = changed;
    button.onclick = () => {
      if (button.disabled || !isCurrent()) return;
      if (!input.value || new TextEncoder().encode(input.value).length > 64) {
        generation++;
        evidence.replaceChildren();
        status.textContent = `Enter a literal destination CIDR (maximum 64 UTF-8 bytes); the server rejects noncanonical values. ${caveat}`;
        return;
      }
      const query = { subnet_id: subnetId, destination_cidr: input.value };
      const version = ++generation;
      const current = () => isCurrent() && version === generation && input.value === query.destination_cidr;
      evidence.replaceChildren();
      button.disabled = input.disabled = true;
      status.textContent = "Reading saved destination-CIDR decisions…";
      void (async () => {
        try {
          const response = await lookup(query);
          if (!current()) return;
          if (!response) {
            status.textContent = `Inspection discarded; refresh the saved view or retry. ${caveat}`;
            return;
          }
          if (response.topology_id !== snapshot.id || response.completed_at !== snapshot.completed_at)
            throw new Error("Snapshot changed; refresh the saved observation before another CIDR inspection");
          const value = JSON.parse(JSON.stringify(response)) as VpcCidrCoverageResponse;
          if (
            value.account_id !== snapshot.account_id ||
            value.aws_account_id !== snapshot.aws_account_id ||
            value.region !== snapshot.region ||
            value.subnet_id !== subnetId ||
            value.destination_cidr !== query.destination_cidr ||
            value.complete_for_supported_queries !== snapshot.complete_for_supported_queries ||
            value.reference_only !== true ||
            value.execution_enabled !== false ||
            value.connectivity_tested !== false
          )
            throw new Error(mismatch);
          strings(value.limitations);
          strings(value.request_ids);
          if (
            !same(value.limitations, snapshot.limitations) ||
            !same(value.request_ids, snapshot.request_ids)
          )
            throw new Error(mismatch);
          const coverage = value.coverage;
          if (
            !coverage ||
            coverage.destination_cidr !== query.destination_cidr ||
            coverage.partition_complete !== true ||
            !Array.isArray(coverage.segments) ||
            !coverage.segments.length
          )
            throw new Error(mismatch);
          const original = coverage.table_evidence;
          if (
            original !== null &&
            (!original ||
              !table ||
              !Number.isSafeInteger(original.route_table_resource_index) ||
              original.route_table_resource_index !== table.at ||
              selection.status !== "selected" ||
              original.route_table_id !== selection.route_table_id ||
              original.source !== selection.source ||
              !same(original.original_table, table.resource))
          )
            throw new Error(mismatch);
          if (original === null && coverage.segments.length !== 1) throw new Error(mismatch);
          for (const cell of coverage.segments) {
            if (!cell) throw new Error(mismatch);
            nonempty(cell.start);
            nonempty(cell.end_inclusive);
            resultValid(cell.result, selection);
            if ((cell.result.status === "reported") !== (original !== null)) throw new Error(mismatch);
          }
          // Full structural/binding validation precedes ANY successful summary/rows. The server owns
          // ordered exact coverage and IP/routing arithmetic; this UI does not rederive a path.
          const staged = document.createDocumentFragment();
          staged.append(
            text(
              "p",
              `Registration ${snapshot.account_id}, AWS account ${snapshot.aws_account_id}, ${snapshot.region}; observation ${snapshot.id}, completed ${snapshot.completed_at}. Supported-query complete: ${snapshot.complete_for_supported_queries}. Destination CIDR: ${query.destination_cidr}.`,
            ),
            batch("Limitations", value.limitations, current),
            batch("Request IDs", value.request_ids, current),
            batch("Decision intervals", coverage.segments, current, true),
          );
          if (original) {
            const raw = document.createElement("details");
            raw.append(
              text(
                "summary",
                `Original table ${original.route_table_id} (${original.source}), resource index ${original.route_table_resource_index}`,
              ),
            );
            let shown = false;
            raw.ontoggle = () => {
              if (!raw.open || shown || !current()) return;
              shown = true;
              for (const [key, data] of Object.entries(original.original_table))
                raw.append(
                  Array.isArray(data)
                    ? batch(key, data, current)
                    : text("p", `${key}: ${JSON.stringify(data)}`),
                );
            };
            staged.append(raw);
          }
          evidence.replaceChildren(staged);
          status.textContent = `Partition complete: ${coverage.segments.length} saved-decision intervals, including unresolved decisions. ${caveat}`;
        } catch (error) {
          if (current())
            status.textContent = `${error instanceof Error ? error.message : "Saved CIDR inspection failed"}. ${caveat}`;
        } finally {
          if (version === generation && isCurrent()) {
            if (!current())
              status.textContent = `Inputs changed; run another saved CIDR inspection. ${caveat}`;
            button.disabled = input.disabled = false;
          }
        }
      })();
    };
  }
  return detail;
}

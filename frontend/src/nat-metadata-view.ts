import type { AwsResource, AwsTopology, NatGatewayAddress, NatGatewayMetadata } from "./generated";
import { text } from "./view";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function address(value: unknown): value is NatGatewayAddress {
  return (
    record(value) &&
    [
      "allocation_id",
      "association_id",
      "network_interface_id",
      "public_ip",
      "private_ip",
      "az_name",
      "az_id",
      "status",
    ].every((key) => nullableString(value[key])) &&
    (value.is_primary === null || typeof value.is_primary === "boolean")
  );
}
function metadataShape(value: unknown): value is NatGatewayMetadata {
  return (
    record(value) &&
    nullableString(value.route_table_id) &&
    (value.addresses === null || (Array.isArray(value.addresses) && value.addresses.every(address)))
  );
}

export function renderNatMetadata(resource: AwsResource, topology: AwsTopology): HTMLDetailsElement {
  const detail = document.createElement("details");
  detail.dataset.natMetadata = resource.id;
  detail.append(text("summary", "Inspect reported NAT metadata"));
  let loaded = false;
  detail.ontoggle = () => {
    if (!detail.open || loaded) return;
    loaded = true;
    if (
      topology.execution_enabled !== false ||
      topology.connectivity_tested !== false ||
      typeof topology.id !== "string" ||
      !topology.id ||
      typeof topology.completed_at !== "string" ||
      !topology.completed_at
    ) {
      detail.append(text("p", "Offline snapshot identity or markers are invalid; refresh the observation"));
      return;
    }
    detail.append(
      text("p", `Saved snapshot: ${topology.id} · completed: ${topology.completed_at}`),
      text("p", `Availability mode: ${resource.availability_mode ?? "not reported"}`),
      text(
        "p",
        "Reported configuration only; not selected egress IPs, not NAT health or a selected traffic AZ. Connectivity and return routing remain untested.",
      ),
    );
    const metadata = resource.nat_gateway;
    if (metadata == null) {
      detail.append(text("p", "NAT details not captured in this observation"));
      return;
    }
    if (!metadataShape(metadata)) {
      detail.append(text("p", "NAT metadata is malformed; no address tuples displayed"));
      return;
    }
    detail.append(
      text(
        "p",
        `Unvalidated routeTableId reference: ${metadata.route_table_id ?? "not reported"} · no route-table association is inferred.`,
      ),
    );
    if (metadata.addresses == null) {
      detail.append(text("p", "Address collection not reported"));
      return;
    }
    const addresses = metadata.addresses;
    detail.append(text("p", `Reported address tuples: ${addresses.length}`));
    const list = document.createElement("ol");
    list.setAttribute("aria-label", "Reported NAT address tuples");
    const count = text("p", "");
    count.setAttribute("aria-live", "polite");
    const more = text("button", "Show more NAT address tuples");
    more.type = "button";
    more.dataset.natMore = "";
    let shown = 0;
    function appendBatch() {
      for (const address of addresses.slice(shown, shown + 50)) {
        const row = document.createElement("li");
        row.dataset.natAddress = "";
        row.append(
          text(
            "p",
            `Public IP: ${address.public_ip ?? "not reported"} · Private IP: ${address.private_ip ?? "not reported"}`,
          ),
          text(
            "p",
            `AZ ID: ${address.az_id ?? "not reported"} · AZ name (account-specific): ${address.az_name ?? "not reported"}`,
          ),
          text(
            "p",
            `Reported status: ${address.status ?? "not reported"} · Reported primary: ${address.is_primary ?? "not reported"}`,
          ),
          text(
            "p",
            `Allocation: ${address.allocation_id ?? "not reported"} · Association: ${address.association_id ?? "not reported"} · Interface: ${address.network_interface_id ?? "not reported"}`,
          ),
        );
        list.append(row);
        shown++;
      }
      count.textContent = `Showing ${shown} of ${addresses.length} reported address tuples`;
      more.hidden = shown >= addresses.length;
    }
    more.onclick = appendBatch;
    appendBatch();
    detail.append(count, list, more);
  };
  return detail;
}

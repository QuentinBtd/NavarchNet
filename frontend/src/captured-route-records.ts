import type { AwsResource, AwsTopology, ObservedRoute, TransitGatewayRoute } from "./generated";
import { text } from "./view";

type Capture = Pick<AwsTopology, "id" | "completed_at"> & { resource_index: number };
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nullable = (v: unknown) => v === null || typeof v === "string";
const reported = (v: string | null) => (v === null ? "not reported" : v === "" ? "empty reported value" : v);
function dense(values: unknown, valid: (value: unknown) => boolean): values is unknown[] {
  if (!Array.isArray(values)) return false;
  for (let i = 0; i < values.length; i++) if (!Object.hasOwn(values, i) || !valid(values[i])) return false;
  return true;
}
function destinations(values: [string, string | null][]): string {
  return (
    values
      .filter(([, value]) => value !== null)
      .map(([label, value]) => `${label}: ${reported(value)}`)
      .join(" · ") || "Destination fields not reported"
  );
}
function validVpc(value: unknown): boolean {
  return (
    object(value) &&
    ["ipv4_destination", "ipv6_destination", "prefix_list_destination", "state", "origin"].every((key) =>
      nullable(value[key]),
    ) &&
    object(value.targets) &&
    Object.values(value.targets).every((v) => typeof v === "string")
  );
}
function validTgw(value: unknown): boolean {
  return (
    object(value) &&
    ["destination_cidr", "prefix_list_id", "state", "route_type", "route_table_announcement_id"].every(
      (key) => nullable(value[key]),
    ) &&
    dense(
      value.attachments,
      (a) => object(a) && ["attachment_id", "resource_id", "resource_type"].every((key) => nullable(a[key])),
    )
  );
}

// Literal captured rows only. No route parsing, longest-prefix decision, target join or AWS call.
export function renderCapturedRouteRecords(
  resource: AwsResource,
  capture: Capture,
  isCurrent: () => boolean,
): HTMLDetailsElement | undefined {
  if (resource.kind !== "route_table" && resource.kind !== "transit_gateway_route_table") return;
  const root = document.createElement("details");
  root.dataset.capturedRouteEntries = "";
  root.dataset.captureId = capture.id;
  root.dataset.resourceIndex = String(capture.resource_index);
  root.append(text("summary", "Reported route entries"));
  const current = (node: HTMLElement) => root.isConnected && isCurrent() && root.contains(node);
  let initialized = false;
  root.ontoggle = () => {
    if (!root.open || initialized || !current(root)) return;
    initialized = true;
    root.append(
      text(
        "p",
        `Completed ${capture.completed_at} · original resource position ${capture.resource_index + 1}. Full capture identity in map provenance.`,
      ),
    );
    root.append(
      text(
        "p",
        "Not effective routing or measured traffic. Target literals and prefix-list contents remain unvalidated; no health or authority is established.",
      ),
    );
    const vpc = resource.kind === "route_table";
    const entries = vpc ? resource.routes : resource.tgw_routes;
    if (!vpc && entries === null) {
      root.append(text("p", "TGW route collection not captured. Its contents are unknown."));
      return;
    }
    if (!dense(entries, vpc ? validVpc : validTgw)) {
      root.append(text("p", "Captured route collection is malformed; no partial route rows displayed."));
      return;
    }
    if (entries.length === 0) {
      root.append(
        text("p", "Zero route records returned in this capture. Absence of routes is not established."),
      );
      return;
    }
    const list = document.createElement("ol"),
      count = text("p", ""),
      more = text("button", "Show more captured routes");
    more.type = "button";
    let shown = 0;
    const append = () => {
      if (!current(more)) return;
      const end = Math.min(shown + 12, entries.length);
      for (; shown < end; shown++) {
        const original = entries[shown];
        const item = document.createElement("li");
        item.dataset.routeIndex = String(shown);
        if (vpc) {
          const row = original as ObservedRoute;
          item.append(
            text(
              "strong",
              destinations([
                ["IPv4", row.ipv4_destination],
                ["IPv6", row.ipv6_destination],
                ["Prefix list", row.prefix_list_destination],
              ]),
            ),
          );
          const targets = Object.entries(row.targets).map(([key, value]) => `${key}: ${reported(value)}`);
          item.append(
            text(
              "p",
              `Reported state: ${reported(row.state)} · origin: ${reported(row.origin)}. Target fields: ${targets.length ? targets.join(" · ") : "none reported"}.`,
            ),
          );
        } else {
          const row = original as TransitGatewayRoute;
          item.append(
            text(
              "strong",
              destinations([
                ["CIDR", row.destination_cidr],
                ["Prefix list", row.prefix_list_id],
              ]),
            ),
          );
          item.append(
            text(
              "p",
              `Reported state: ${reported(row.state)} · type: ${reported(row.route_type)}${row.route_table_announcement_id !== null ? ` · announcement: ${reported(row.route_table_announcement_id)}` : ""}. Reported attachment rows: ${row.attachments.length}; original literals below, not resolved connections.`,
            ),
          );
        }
        const detail = document.createElement("details");
        detail.append(text("summary", "Original route record"));
        detail.ontoggle = () => {
          if (detail.open && current(detail) && !detail.querySelector("pre"))
            detail.append(text("pre", JSON.stringify(original, null, 2)));
        };
        item.append(detail);
        list.append(item);
      }
      count.textContent = `Showing ${shown} of ${entries.length} captured route rows · original order, local batches, not a cloud total.`;
      more.hidden = shown >= entries.length;
    };
    more.onclick = append;
    root.append(count, list, more);
    append();
  };
  return root;
}

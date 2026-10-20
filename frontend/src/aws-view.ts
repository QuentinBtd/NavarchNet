import type { AdoptionConsent, TopologyView } from "./generated";
import { text } from "./view";
export function renderAwsTopology(
  view: TopologyView,
  options: { canConsent: boolean; onConsent: (consent: AdoptionConsent) => Promise<void> },
): HTMLElement {
  const root = document.createElement("section");
  const topology = view.topology;
  const tableSelections = new Map(
    view.subnet_route_tables.map((value) => [value.subnet_id, value.selection]),
  );
  root.append(
    text("h3", `AWS observation · ${topology.aws_account_id} · ${topology.region}`),
    text("p", "AWS execution is disabled. No measured connectivity, isolation or egress path is available."),
    text(
      "p",
      "Subnet table selection describes reported associations, not an effective packet path or validated routing.",
    ),
    text(
      "p",
      `Supported-query scan: ${topology.complete_for_supported_queries ? "complete" : "incomplete"}. This is not an executable network inventory.`,
    ),
    text(
      "p",
      `Observed public addresses (not a tested egress path): ${[...new Set(topology.resources.flatMap((r) => r.public_ips))].join(", ") || "none reported"}`,
    ),
  );
  const limitations = document.createElement("ul");
  for (const limitation of topology.limitations) limitations.append(text("li", limitation));
  root.append(limitations);
  const count = text("p", "");
  const list = document.createElement("div");
  const more = text("button", "Show more observed records");
  more.type = "button";
  let limit = 200;
  function renderRows() {
    count.textContent = `Showing ${Math.min(limit, topology.resources.length)} of ${topology.resources.length} resource and sharing records. Nothing is automatically adopted.`;
    list.replaceChildren(
      ...topology.resources.slice(0, limit).map((resource, index) => {
        const row = document.createElement("article");
        row.append(text("h4", `${resource.kind} · ${resource.id}`));
        if (resource.tags.Name) row.append(text("p", resource.tags.Name));
        row.append(
          text(
            "p",
            `Owner: ${resource.owner_account_id ?? "not reported"} · VPC: ${resource.vpc_id ?? "not reported"} · AZ ID: ${resource.az_id ?? "not reported"}`,
          ),
          text(
            "p",
            `Reported state: ${resource.state ?? "unknown"} · CIDRs: ${resource.cidrs.join(", ") || "none reported"}`,
          ),
        );
        if (resource.related_ids.length)
          row.append(text("p", `Related resources or shares: ${resource.related_ids.join(", ")}`));
        const selection = resource.kind === "subnet" ? tableSelections.get(resource.id) : undefined;
        if (selection)
          row.append(
            text(
              "p",
              selection.status === "selected"
                ? `${resource.id} → ${selection.route_table_id} · observed ${selection.source}`
                : `${resource.id} · table selection unresolved: ${selection.reason}`,
            ),
          );
        if (resource.public_ips.length)
          row.append(text("p", `Reported public IPs: ${resource.public_ips.join(", ")}`));
        if (resource.availability_mode)
          row.append(
            text(
              "p",
              `NAT availability mode: ${resource.availability_mode} · discovery does not select a supported egress model`,
            ),
          );
        if (resource.routes.length || resource.associations.length) {
          const detail = document.createElement("details");
          detail.append(
            text(
              "summary",
              `Observed routes (${resource.routes.length}) and associations (${resource.associations.length})`,
            ),
          );
          for (const route of resource.routes)
            detail.append(
              text(
                "p",
                `${route.ipv4_destination ?? route.ipv6_destination ?? route.prefix_list_destination ?? "Unknown destination"} → ${
                  Object.entries(route.targets)
                    .map(([kind, id]) => `${kind}=${id}`)
                    .join(", ") || "target not reported"
                } · ${route.state ?? "unknown state"} · ${route.origin ?? "unknown origin"}`,
              ),
            );
          for (const association of resource.associations)
            detail.append(
              text(
                "p",
                `${
                  association.main
                    ? "Main route table: implicit subnet associations are not individually returned by AWS."
                    : `Explicit subnet: ${association.subnet_id ?? "not reported"} · gateway: ${association.gateway_id ?? "not reported"}`
                } · association state: ${association.state ?? "not reported"}`,
              ),
            );
          row.append(detail);
        }
        if (resource.kind === "transit_gateway_route_table") {
          const detail = document.createElement("details");
          detail.append(text("summary", "Observed TGW table relationships"));
          for (const [label, links] of [
            ["associations", resource.tgw_associations],
            ["propagations", resource.tgw_propagations],
          ] as const) {
            detail.append(
              text(
                "p",
                links == null
                  ? `TGW ${label} not queried in this observation`
                  : `TGW ${label}: ${links.length}`,
              ),
            );
            for (const link of links ?? [])
              detail.append(
                text(
                  "p",
                  `${label} · attachment: ${link.attachment_id ?? "not reported"} · resource: ${link.resource_id ?? "not reported"} · type: ${link.resource_type ?? "unknown"} · reported state: ${link.state ?? "unknown"} · announcement: ${link.route_table_announcement_id ?? "none reported"}`,
                ),
              );
          }
          detail.append(
            text("p", "Reported relationships do not prove forwarding, return routes or isolation."),
          );
          row.append(detail);
        }
        const adopted = view.adoptions.find(
          (record) => record.resource_id === resource.id && record.resource_kind === resource.kind,
        );
        if (adopted)
          row.append(
            text(
              "p",
              "Metadata consent recorded. Existing routes and related resources are not adopted; execution remains disabled.",
            ),
          );
        const eligible =
          options.canConsent &&
          topology.complete_for_supported_queries &&
          !topology.execution_enabled &&
          resource.owner_account_id === topology.aws_account_id &&
          ["vpc", "transit_gateway"].includes(resource.kind) &&
          !adopted;
        if (eligible) {
          const form = document.createElement("form");
          const label = text(
            "label",
            "Reason for adopting this one resource's metadata (no route or related-resource ownership)",
          );
          const reason = document.createElement("input");
          reason.id = `aws-adoption-reason-${index}`;
          label.htmlFor = reason.id;
          reason.required = true;
          reason.maxLength = 1000;
          const submit = text("button", "Authorize metadata adoption");
          submit.type = "submit";
          submit.dataset.awsWrite = "";
          const status = text("p", "");
          status.setAttribute("role", "status");
          form.append(label, reason, submit, status);
          form.onsubmit = (event) => {
            event.preventDefault();
            if (!options.canConsent) {
              status.textContent = "Metadata consent is no longer enabled for this session.";
              return;
            }
            if (submit.disabled || !reason.value.trim()) {
              status.textContent = "An explicit reason is required.";
              return;
            }
            submit.disabled = true;
            void (async () => {
              try {
                await options.onConsent({
                  topology_id: topology.id,
                  resource_kind: resource.kind,
                  resource_id: resource.id,
                  reason: reason.value,
                });
                reason.value = "";
              } catch (error) {
                status.textContent = error instanceof Error ? error.message : "Metadata consent failed";
              } finally {
                submit.disabled = !options.canConsent;
              }
            })();
          };
          row.append(form);
        }
        return row;
      }),
    );
    more.hidden = limit >= topology.resources.length;
  }
  more.onclick = () => {
    limit += 200;
    renderRows();
  };
  renderRows();
  root.append(count, list, more);
  return root;
}

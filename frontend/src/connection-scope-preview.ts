import type { Inventory } from "./generated";
import { text } from "./view";

// Current form selection and returned simulation metadata only; never a computed change plan.
export function renderConnectionScopePreview(
  inventory: Inventory | undefined,
  selectedIds: string[],
): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Selected attachment scope");
  root.append(text("h4", "Selected attachment scope"));
  const unavailable = () => {
    root.append(
      text(
        "p",
        "Selected attachment context unavailable or ambiguous. Refresh or choose a unique discovered scope.",
      ),
    );
    return root;
  };
  const literal = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  if (
    !inventory ||
    ![inventory.account_id, inventory.vpc_id, inventory.cidr, inventory.region].every(literal) ||
    !Number.isSafeInteger(inventory.revision) ||
    inventory.revision < 0 ||
    !Array.isArray(inventory.subnets) ||
    !Array.isArray(selectedIds)
  )
    return unavailable();
  const byId = new Map<string, Inventory["subnets"][number]>();
  for (let i = 0; i < inventory.subnets.length; i++) {
    if (!Object.hasOwn(inventory.subnets, i)) return unavailable();
    const subnet = inventory.subnets[i];
    if (!subnet || ![subnet.id, subnet.az_id, subnet.route_table].every(literal) || byId.has(subnet.id))
      return unavailable();
    byId.set(subnet.id, subnet);
  }
  const selected: Inventory["subnets"] = [];
  const ids = new Set<string>();
  for (let i = 0; i < selectedIds.length; i++) {
    if (!Object.hasOwn(selectedIds, i)) return unavailable();
    const id = selectedIds[i],
      subnet = byId.get(id);
    if (!literal(id) || !subnet || ids.has(id)) return unavailable();
    ids.add(id);
    selected.push(subnet);
  }
  root.dataset.vpcId = inventory.vpc_id;
  root.append(
    text(
      "p",
      `Current account registration ${inventory.account_id} · VPC ${inventory.vpc_id} · ${inventory.cidr} · ${inventory.region} · inventory revision ${inventory.revision}.`,
    ),
  );
  root.append(
    text(
      "p",
      `${selected.length} selected attachment subnets · ${new Set(selected.map((s) => s.az_id)).size} reported AZ IDs · ${new Set(selected.map((s) => s.route_table)).size} reported route tables.`,
    ),
  );
  const rows = document.createElement("ul");
  for (const subnet of selected.slice(0, 6)) {
    const row = text("li", `${subnet.id} · ${subnet.az_id} · reported table ${subnet.route_table}`);
    row.dataset.selectedSubnet = subnet.id;
    rows.append(row);
  }
  if (selected.length) root.append(rows);
  if (selected.length > 6)
    root.append(
      text(
        "p",
        `Showing 6 of ${selected.length} selected subnets here; the checkboxes above retain every selection.`,
      ),
    );
  if (!selected.length) root.append(text("p", "No attachment subnet selected."));
  root.append(
    text(
      "small",
      "Current simulation selection, not a generated plan or observed routing. Generate explicitly to review actions; connectivity is not measured.",
    ),
  );
  return root;
}

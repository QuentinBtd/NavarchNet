import type { Inventory, Plan, RegionalNetwork, Subnet } from "./generated";
import { text } from "./view";

export function captureRequestedPlan(plan: Plan | null | undefined) {
  if (!plan || !["id", "digest", "request"].every((key) => Object.hasOwn(plan, key))) return;
  const { id, digest, request } = plan;
  if (typeof id !== "string" || !id || typeof digest !== "string" || !digest || !request) return;
  if (!["account_id", "vpc_id", "network_id", "subnet_ids"].every((key) => Object.hasOwn(request, key)))
    return;
  if (
    ![request.account_id, request.vpc_id, request.network_id].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    return;
  const ids = request.subnet_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) return;
  const captured: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!Object.hasOwn(ids, i) || typeof ids[i] !== "string" || !ids[i]) return;
    captured.push(ids[i]);
  }
  if (new Set(captured).size !== captured.length) return;
  try {
    return { plan, id, digest, request, ids, captured, requestJson: JSON.stringify(request) };
  } catch {
    return;
  }
}

type Captured = ReturnType<typeof captureRequestedPlan>;
// Original requested IDs and a separate current literal-ID match, never historical membership or validity.
export function renderRequestedSubnets(
  plan: Plan | null,
  original: Captured,
  scope: { inventory: Inventory; network: RegionalNetwork } | undefined,
  inventory: Inventory | undefined,
  network: RegionalNetwork,
): { element: HTMLElement; matched: Set<Subnet> } {
  const element = document.createElement("section");
  element.setAttribute("role", "region");
  element.setAttribute("aria-label", "Original plan requested subnets");
  const matched = new Set<Subnet>();
  const current = captureRequestedPlan(plan);
  if (
    !current ||
    !original ||
    current.plan !== original.plan ||
    current.id !== original.id ||
    current.digest !== original.digest ||
    current.request !== original.request ||
    current.ids !== original.ids ||
    current.requestJson !== original.requestJson ||
    !scope ||
    scope.inventory !== inventory ||
    scope.network !== network
  ) {
    element.append(
      text(
        "p",
        "Original requested-subnet context unavailable for this returned scope. Locate the original plan again after review.",
      ),
    );
    return { element, matched };
  }
  element.dataset.planId = original.id;
  element.dataset.planDigest = original.digest;
  element.append(
    text("h4", "Original requested attachment subnets"),
    text(
      "p",
      "Requested intent, not historical membership or an applied connection. Current ID matches do not establish validity or connectivity.",
    ),
  );
  const list = document.createElement("ul");
  for (const id of original.captured) {
    const item = text("li", id);
    item.dataset.requestedSubnet = "";
    list.append(item);
  }
  element.append(list);
  if (!inventory || !Array.isArray(inventory.subnets)) return { element, matched };
  const rows = new Map<string, Subnet>();
  for (let i = 0; i < inventory.subnets.length; i++) {
    const row = inventory.subnets[i];
    if (
      !Object.hasOwn(inventory.subnets, i) ||
      !row ||
      !Object.hasOwn(row, "id") ||
      typeof row.id !== "string" ||
      !row.id ||
      rows.has(row.id)
    ) {
      element.append(
        text("p", "Current requested-subnet match unavailable or ambiguous. No requested badges shown."),
      );
      return { element, matched };
    }
    rows.set(row.id, row);
  }
  for (const id of original.captured) {
    const row = rows.get(id);
    if (!row) {
      element.append(
        text("p", "Current requested-subnet match unavailable or ambiguous. No requested badges shown."),
      );
      return { element, matched };
    }
  }
  for (const id of original.captured) {
    const row = rows.get(id);
    if (row) matched.add(row);
  }
  element.append(
    text(
      "p",
      `All ${matched.size} requested IDs uniquely match returned subnet records at inventory revision ${inventory.revision}. This is current metadata, not original membership.`,
    ),
  );
  return { element, matched };
}

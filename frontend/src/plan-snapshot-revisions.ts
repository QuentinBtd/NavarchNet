import type { Plan, Snapshot } from "./generated";
import { text } from "./view";

type Context = Pick<Snapshot, "plans" | "inventory" | "networks">;
const literal = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
function dense<T>(values: T[], valid: (value: T) => boolean): boolean {
  if (!Array.isArray(values)) return false;
  for (let i = 0; i < values.length; i++)
    if (!Object.hasOwn(values, i) || !values[i] || !valid(values[i])) return false;
  return true;
}

// Separate current returned metadata from original immutable evidence; never authorize apply.
export function renderPlanSnapshotRevisions(plan: Plan, snapshot: Context | undefined): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Plan revision comparison");
  root.dataset.revisionComparison = "unavailable";
  root.append(text("h4", "Plan vs returned simulation snapshot"));
  if (
    !snapshot ||
    !literal(plan.id) ||
    !plan.request ||
    ![plan.request.account_id, plan.request.vpc_id, plan.request.network_id].every(literal) ||
    !revision(plan.inventory_revision) ||
    !revision(plan.network_revision) ||
    !dense(snapshot.plans, (p) => literal(p.id)) ||
    new Set(snapshot.plans.map((p) => p.id)).size !== snapshot.plans.length ||
    snapshot.plans.find((p) => p.id === plan.id) !== plan ||
    !dense(snapshot.inventory, (i) => literal(i.account_id) && literal(i.vpc_id) && revision(i.revision)) ||
    new Set(snapshot.inventory.map((i) => JSON.stringify([i.account_id, i.vpc_id]))).size !==
      snapshot.inventory.length ||
    !dense(snapshot.networks, (n) => literal(n.id) && revision(n.revision)) ||
    new Set(snapshot.networks.map((n) => n.id)).size !== snapshot.networks.length
  ) {
    root.append(text("p", "Snapshot revision comparison unavailable or ambiguous. Refresh the snapshot."));
    return root;
  }
  const inventory = snapshot.inventory.find(
    (i) => i.account_id === plan.request.account_id && i.vpc_id === plan.request.vpc_id,
  );
  const network = snapshot.networks.find((n) => n.id === plan.request.network_id);
  if (!inventory || !network) {
    root.append(text("p", "Snapshot revision comparison unavailable or ambiguous. Refresh the snapshot."));
    return root;
  }
  const equal = inventory.revision === plan.inventory_revision && network.revision === plan.network_revision;
  root.dataset.revisionComparison = equal ? "equal" : "different";
  const values = document.createElement("dl");
  values.append(
    text("dt", "Inventory revision"),
    text("dd", `Plan ${plan.inventory_revision} · returned snapshot ${inventory.revision}`),
    text("dt", "Regional network revision"),
    text("dd", `Plan ${plan.network_revision} · returned snapshot ${network.revision}`),
  );
  root.append(
    values,
    text(
      "p",
      equal
        ? "Reported revisions match; this is not apply approval."
        : "Reported revisions differ. Refresh or generate a new plan explicitly; the server still validates apply.",
    ),
    text(
      "p",
      "Current scope version is not returned; matching revisions cannot establish plan validity or connectivity.",
    ),
  );
  return root;
}

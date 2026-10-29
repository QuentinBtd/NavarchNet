import type { ActionKind, Operation, Plan, Snapshot } from "./generated";
import { renderPlanSnapshotRevisions } from "./plan-snapshot-revisions";
import { text } from "./view";

const labels: Record<ActionKind, string> = {
  attachment: "Create simulated attachment",
  isolation: "Enforce application isolation",
  return_route: "Configure return route",
  nat_route: "Configure NAT route",
  spoke_default_route: "Set application default route",
};
type ReviewOptions = {
  selectedPlanId?: string;
  isCurrent: () => boolean;
  onSelect: (id: string) => void;
  makeApply: (plan: Plan) => HTMLButtonElement;
  operations?: Operation[];
  onReviewOperation?: (plan: Plan, operation: Operation) => void;
  currentSnapshot?: Pick<Snapshot, "plans" | "inventory" | "networks">;
};

export function recordedOperationForPlan(
  plan: Plan,
  operations: Operation[] | undefined,
): Operation | undefined {
  const literal = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  if (!literal(plan.id) || !literal(plan.scope) || !Array.isArray(operations)) return;
  for (let i = 0; i < operations.length; i++) {
    if (!Object.hasOwn(operations, i)) return;
    const operation = operations[i];
    if (!operation || ![operation.id, operation.plan_id, operation.scope].every(literal)) return;
  }
  const matches = operations.filter((operation) => operation.plan_id === plan.id);
  const operation = matches.length === 1 ? matches[0] : undefined;
  return operation &&
    operation.scope === plan.scope &&
    operations.filter((record) => record.id === operation.id).length === 1
    ? operation
    : undefined;
}

function renderImpact(plan: Plan): HTMLElement {
  const root = document.createElement("div");
  root.className = "plan-impact";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Plan impact comparison");
  root.dataset.planId = plan.id;
  root.dataset.planDigest = plan.digest;
  const before = document.createElement("div");
  before.className = "plan-impact-before";
  before.append(
    text("h4", "Before · evidence unavailable"),
    text(
      "p",
      "Original route targets are not stored in this plan. Existing routes, prior connectivity and changes already applied cannot be reconstructed from its revisions.",
    ),
    text(
      "p",
      `Plan references inventory revision ${plan.inventory_revision} and network revision ${plan.network_revision}; these are not captured route tables.`,
    ),
  );
  const proposed = document.createElement("div");
  proposed.className = "plan-impact-proposed";
  proposed.append(text("h4", "Proposed simulation · not an operation result"));
  const intent = document.createElement("div");
  intent.className = "plan-impact-intent";
  for (const [label, id] of [
    ["Selected VPC", plan.request.vpc_id],
    ["Requested regional network", plan.request.network_id],
  ]) {
    const scope = document.createElement("div");
    scope.append(text("strong", label), text("code", id));
    intent.append(scope);
  }
  proposed.append(
    intent,
    text(
      "p",
      `${plan.request.subnet_ids.length} selected attachment subnets · ${plan.actions.length} planned actions.`,
    ),
  );
  const requestScope = document.createElement("dl");
  const account = text("dd", plan.request.account_id);
  account.dataset.requestAccount = "";
  const subnets = document.createElement("ul");
  subnets.dataset.requestSubnets = "";
  for (const id of plan.request.subnet_ids) subnets.append(text("li", id));
  const subnetValues = document.createElement("dd");
  subnetValues.append(subnets);
  requestScope.append(
    text("dt", "Requested account registration"),
    account,
    text("dt", "Requested attachment subnets"),
    subnetValues,
  );
  proposed.append(requestScope);
  proposed.append(
    text(
      "p",
      plan.request.allow_application_traffic === true
        ? "Application traffic requested — review its policy and prerequisites."
        : plan.request.allow_application_traffic === false
          ? "No application-to-application access requested."
          : "Application-traffic policy unavailable.",
    ),
  );
  const groups = new Map<ActionKind, string[]>();
  for (const action of plan.actions) {
    const targets = groups.get(action.kind) ?? [];
    targets.push(action.target);
    groups.set(action.kind, targets);
  }
  const targets = document.createElement("dl");
  for (const [kind, values] of groups) {
    const group = document.createElement("div");
    group.dataset.actionKind = kind;
    group.append(text("dt", `${labels[kind] ?? kind} · ${values.length}`), text("dd", values.join(", ")));
    targets.append(group);
  }
  proposed.append(text("p", "Affected targets, grouped by action — not step order:"), targets);
  root.append(before, proposed);
  return root;
}

// Local presentation only: no request, plan recomputation, new permissions or identifier repair.
export function renderPlanReview(plans: Plan[], options: ReviewOptions): HTMLElement {
  const root = document.createElement("div");
  root.append(text("p", `${plans.length} returned plans · bounded history, not the database total.`));
  if (plans.length === 0) {
    root.append(text("p", "No returned change plan. Configure a VPC connection first."));
    return root;
  }
  const selectedId = options.selectedPlanId ?? plans[0]?.id;
  const label = text("label", "Plan to review");
  label.htmlFor = "plan-selection";
  const select = document.createElement("select");
  select.id = "plan-selection";
  for (const plan of plans) {
    const option = text(
      "option",
      `${plan.request.vpc_id} · ${plan.actions.length} actions · ${plan.id.slice(0, 8)}`,
    );
    option.value = plan.id;
    select.append(option);
  }
  select.value = selectedId ?? "";
  select.onchange = () => {
    if (root.isConnected && options.isCurrent() && plans.some((plan) => plan.id === select.value))
      options.onSelect(select.value);
  };
  root.append(label, select);
  const matches = plans.filter((plan) => plan.id === selectedId);
  if (matches.length !== 1) {
    select.value = "";
    root.append(
      text("p", "Selected plan unavailable or ambiguous. Choose a returned plan; refresh if needed."),
    );
    return root;
  }
  const plan = matches[0];
  if (!plan) return root;
  const card = document.createElement("article");
  card.dataset.planId = plan.id;
  card.append(
    text("h3", `Review connection plan · ${plan.actions.length} actions`),
    text("p", `Impact: ${plan.request.vpc_id} · ${plan.request.subnet_ids.length} attachment subnets.`),
    text(
      "p",
      "Simulation plan · active connectivity not tested. Review every prerequisite and postcondition.",
    ),
  );
  const actions = document.createElement("ol");
  for (const action of plan.actions) {
    const item = document.createElement("li");
    item.append(
      text("strong", labels[action.kind] ?? action.kind),
      text(
        "p",
        `Requires steps: ${action.requires.map((i) => i + 1).join(", ") || "none"}. Verify: ${action.postcondition}`,
      ),
    );
    actions.append(item);
  }
  const technical = document.createElement("details");
  const originalJson = JSON.stringify(plan, null, 2);
  technical.append(
    text("summary", "Technical plan identifiers & original evidence"),
    text("pre", originalJson),
  );
  technical.append(text("h4", "Ordered prerequisites & required postconditions"), actions);
  const download = text("button", "Download original plan JSON");
  download.type = "button";
  download.dataset.planExport = "";
  download.onclick = () => {
    if (download.disabled || !root.isConnected || !root.contains(download) || !options.isCurrent()) return;
    const url = URL.createObjectURL(new Blob([originalJson], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "navarchnet-plan.json";
    link.hidden = true;
    card.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };
  card.append(renderImpact(plan));
  if (options.currentSnapshot)
    card.append(
      renderPlanSnapshotRevisions(
        plan,
        options.currentSnapshot.plans === plans ? options.currentSnapshot : undefined,
      ),
    );
  card.append(technical, options.makeApply(plan), download);
  if (options.onReviewOperation) {
    const operation = recordedOperationForPlan(plan, options.operations);
    const review = text("button", "Review recorded operation");
    review.type = "button";
    review.dataset.planOperation = "";
    review.disabled = !operation;
    review.onclick = () => {
      if (
        !review.disabled &&
        operation &&
        root.isConnected &&
        root.contains(review) &&
        options.isCurrent() &&
        recordedOperationForPlan(plan, options.operations) === operation
      )
        options.onReviewOperation?.(plan, operation);
    };
    card.append(review);
    if (!operation)
      card.append(
        text("p", "Recorded operation unavailable or ambiguous in returned history. Refresh to look for it."),
      );
  }
  root.append(card);
  return root;
}

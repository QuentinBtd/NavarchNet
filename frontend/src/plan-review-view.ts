import type { ActionKind, Inventory, Operation, Plan, RegionalNetwork, Snapshot } from "./generated";
import { configurationForPlan, workspaceForPlan } from "./network-workspace";
import { renderPlanActionDetail } from "./plan-action-detail";
import { planReviewHref } from "./plan-review-link";
import { renderPlanSnapshotRevisions } from "./plan-snapshot-revisions";
import { text } from "./view";

export const actionLabels: Record<ActionKind, string> = {
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
  canReconfigure?: boolean;
  onReconfigure?: (plan: Plan) => void;
  workspaceSnapshot?: Pick<Snapshot, "accounts" | "inventory" | "networks" | "plans">;
  onLocateScope?: (plan: Plan, inventory: Inventory, network: RegionalNetwork) => void;
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
    group.append(
      text("dt", `${actionLabels[kind] ?? kind} · ${values.length}`),
      text("dd", values.join(", ")),
    );
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
      text("strong", actionLabels[action.kind] ?? action.kind),
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
  if (options.onLocateScope) {
    const source = options.workspaceSnapshot;
    const scope = source?.plans === plans ? workspaceForPlan(source, plan) : undefined;
    const original = {
      id: plan.id,
      account: plan.request.account_id,
      vpc: plan.request.vpc_id,
      network: plan.request.network_id,
    };
    const locate = text("button", "Locate requested scope on map");
    locate.type = "button";
    locate.dataset.planMap = "";
    locate.disabled = !scope;
    locate.onclick = () => {
      if (
        locate.disabled ||
        !scope ||
        !source ||
        !root.isConnected ||
        !root.contains(locate) ||
        !options.isCurrent() ||
        source.plans !== plans ||
        plan.id !== original.id ||
        plan.request.account_id !== original.account ||
        plan.request.vpc_id !== original.vpc ||
        plan.request.network_id !== original.network
      )
        return;
      const current = workspaceForPlan(source, plan);
      if (current?.inventory === scope.inventory && current.network === scope.network)
        options.onLocateScope?.(plan, scope.inventory, scope.network);
    };
    card.append(
      locate,
      text(
        "p",
        scope
          ? "Returned map metadata, not current connection or plan validity."
          : "Requested map scope unavailable or ambiguous in returned context. Refresh to look for it.",
      ),
    );
  }
  if (options.onReconfigure) {
    const source = options.workspaceSnapshot;
    const configuration = source?.plans === plans ? configurationForPlan(source, plan) : undefined;
    const original = JSON.stringify(plan.request);
    const originalId = plan.id;
    const prepare = text("button", "Configure another plan from original request");
    prepare.dataset.planReconfigure = "";
    prepare.type = "button";
    prepare.disabled = !options.canReconfigure || !configuration;
    prepare.onclick = () => {
      if (
        prepare.disabled ||
        !options.canReconfigure ||
        !configuration ||
        !source ||
        source.plans !== plans ||
        !root.isConnected ||
        !root.contains(prepare) ||
        !options.isCurrent() ||
        plan.id !== originalId ||
        JSON.stringify(plan.request) !== original
      )
        return;
      const current = configurationForPlan(source, plan);
      if (
        current?.inventory === configuration.inventory &&
        current.network === configuration.network &&
        current.subnets.length === configuration.subnets.length &&
        current.subnets.every((subnet, index) => subnet === configuration.subnets[index])
      )
        options.onReconfigure?.(plan);
    };
    card.append(
      prepare,
      text(
        "p",
        configuration
          ? "Generate a new immutable plan explicitly. This local preparation does not retry or apply the original plan."
          : "Original request cannot be represented uniquely using returned inventory. Configure manually after review.",
      ),
    );
  }
  const actionDetail: HTMLElement = renderPlanActionDetail(
    plan,
    actionLabels,
    () => options.isCurrent() && root.contains(card) && card.contains(actionDetail),
  );
  card.append(actionDetail);
  const href = planReviewHref(plan.id);
  if (href) {
    const originalId = plan.id;
    const link = text("a", "Link to this returned plan");
    link.dataset.planReviewLink = "";
    link.href = href;
    link.onclick = (event) => {
      try {
        if (
          !root.isConnected ||
          !root.contains(link) ||
          !options.isCurrent() ||
          link.getAttribute("aria-disabled") === "true" ||
          link.getAttribute("href") !== href ||
          plan.id !== originalId ||
          plans.filter((row) => row.id === originalId).length !== 1 ||
          !plans.includes(plan) ||
          JSON.stringify(plan, null, 2) !== originalJson
        )
          event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    card.append(
      link,
      text(
        "p",
        "Selects this identity in returned history after authentication; not a permanent storage link.",
      ),
    );
  }
  root.append(card);
  return root;
}

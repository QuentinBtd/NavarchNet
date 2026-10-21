import type { ActionKind, Plan } from "./generated";
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
};

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
  technical.append(
    text("summary", "Technical plan identifiers & original evidence"),
    text("pre", JSON.stringify(plan, null, 2)),
  );
  card.append(actions, technical, options.makeApply(plan));
  root.append(card);
  return root;
}

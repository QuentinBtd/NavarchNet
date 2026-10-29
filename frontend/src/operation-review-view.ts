import type { Operation, Plan } from "./generated";
import { operationReviewHref } from "./operation-review-link";
import { operationLabel, text } from "./view";

type Options = {
  selectedOperationId?: string;
  isCurrent: () => boolean;
  onSelect: (id: string) => void;
  makeInspect: (operation: Operation) => HTMLButtonElement;
  makeDrift?: (operation: Operation) => HTMLButtonElement;
  onReviewPlan?: (plan: Plan) => void;
};

export function originalPlanForOperation(
  operation: Operation,
  operations: Operation[],
  plans: Plan[],
): Plan | undefined {
  const literal = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  if (!operation || !Array.isArray(operations) || !Array.isArray(plans)) return;
  for (const [rows, fields] of [
    [operations, ["id", "plan_id", "scope"]],
    [plans, ["id", "scope"]],
  ] as const) {
    const ids = new Set<string>();
    for (let index = 0; index < rows.length; index++) {
      if (!Object.hasOwn(rows, index)) return;
      const row = rows[index];
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        fields.some(
          (field) =>
            !Object.hasOwn(row, field) || !literal((row as unknown as Record<string, unknown>)[field]),
        )
      )
        return;
      if (ids.has(row.id)) return;
      ids.add(row.id);
    }
  }
  if (operations.find((record) => record.id === operation.id) !== operation) return;
  const plan = plans.find((record) => record.id === operation.plan_id);
  return plan?.scope === operation.scope ? plan : undefined;
}

export function renderOperationReview(operations: Operation[], plans: Plan[], options: Options): HTMLElement {
  const root = document.createElement("div");
  root.append(
    text("p", `${operations.length} returned operations · bounded history, not the database total.`),
  );
  if (operations.length === 0) {
    root.append(text("p", "No returned operation. Review and apply a simulation plan first."));
    return root;
  }
  const selectedId = options.selectedOperationId ?? operations[0]?.id;
  const label = text("label", "Operation to inspect");
  label.htmlFor = "operation-selection";
  const select = document.createElement("select");
  select.id = "operation-selection";
  for (const operation of operations) {
    const option = text(
      "option",
      `${operation.status} · step ${operation.step} · ${operation.id.slice(0, 8)}`,
    );
    option.value = operation.id;
    select.append(option);
  }
  select.value = selectedId ?? "";
  select.onchange = () => {
    if (
      root.isConnected &&
      options.isCurrent() &&
      operations.some((operation) => operation.id === select.value)
    )
      options.onSelect(select.value);
  };
  root.append(label, select);
  const matches = operations.filter((operation) => operation.id === selectedId);
  const operation = matches.length === 1 ? matches[0] : undefined;
  if (!operation) {
    select.value = "";
    root.append(
      text(
        "p",
        "Selected operation unavailable or ambiguous. Choose a returned operation; refresh if needed.",
      ),
    );
    return root;
  }
  const card = document.createElement("article");
  card.dataset.operationId = operation.id;
  const plan = originalPlanForOperation(operation, operations, plans);
  const originalIdentity = { id: operation.id, plan_id: operation.plan_id, scope: operation.scope };
  const status =
    operation.status === "succeeded"
      ? "Simulation converged"
      : operation.status === "partial"
        ? "Partial completion — manual review required"
        : operation.status;
  card.append(
    text(
      "h3",
      plan
        ? operationLabel(operation.status, operation.step, plan.actions.length)
        : `${status} · reported step ${operation.step} · plan total unavailable in returned history`,
    ),
    text(
      "p",
      `Retries for current step: ${operation.attempts}. Persisted progress is not a connectivity measurement.`,
    ),
  );
  if (operation.error) card.append(text("p", operation.error));
  if (options.onReviewPlan) {
    const review = text("button", "Review original plan");
    review.type = "button";
    review.disabled = !plan;
    review.onclick = () => {
      if (
        !review.disabled &&
        plan &&
        root.isConnected &&
        root.contains(review) &&
        options.isCurrent() &&
        operation.id === originalIdentity.id &&
        operation.plan_id === originalIdentity.plan_id &&
        operation.scope === originalIdentity.scope &&
        originalPlanForOperation(operation, operations, plans) === plan
      )
        options.onReviewPlan?.(plan);
    };
    card.append(review);
    if (!plan)
      card.append(
        text("p", "Original plan unavailable or ambiguous in returned history. Refresh to look for it."),
      );
  }
  const originalJson = JSON.stringify(operation, null, 2);
  const technical = document.createElement("details");
  technical.append(
    text("summary", "Technical operation identifiers & persisted state"),
    text("pre", originalJson),
  );
  const inspect = options.makeInspect(operation);
  inspect.dataset.operationAction = "";
  card.append(technical, inspect);
  if (options.makeDrift && ["succeeded", "partial", "failed"].includes(operation.status)) {
    const drift = options.makeDrift(operation);
    drift.dataset.operationAction = "";
    card.append(drift);
  }
  const href = operationReviewHref(originalIdentity.id);
  if (href) {
    const link = text("a", "Link to this returned operation");
    link.dataset.operationReviewLink = "";
    link.href = href;
    link.onclick = (event) => {
      try {
        if (
          !root.isConnected ||
          !root.contains(link) ||
          !card.contains(link) ||
          !options.isCurrent() ||
          link.getAttribute("aria-disabled") === "true" ||
          link.getAttribute("href") !== href ||
          operation.id !== originalIdentity.id ||
          !operations.includes(operation) ||
          operations.filter((row) => row.id === originalIdentity.id).length !== 1 ||
          JSON.stringify(operation, null, 2) !== originalJson
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
        "Selects this identity in returned history after authentication; persisted state may change. Not a permanent storage link.",
      ),
    );
  }
  root.append(card);
  return root;
}

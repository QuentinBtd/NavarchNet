import type { Operation, Plan } from "./generated";
import { originalPlanForOperation } from "./operation-review-view";
import { actionLabels } from "./plan-review-view";
import { text } from "./view";

type OriginalContext = { operation: Operation; operations: Operation[]; plans: Plan[] };
function capturedActions(context: OriginalContext | undefined, operationId: string) {
  if (!context?.operation || context.operation.id !== operationId) return;
  const plan = originalPlanForOperation(context.operation, context.operations, context.plans);
  if (!plan || !Array.isArray(plan.actions)) return;
  const actions: { kind: string; label: string; target: string; planId: string }[] = [];
  for (let index = 0; index < plan.actions.length; index++) {
    if (!Object.hasOwn(plan.actions, index)) return;
    const action = plan.actions[index];
    if (
      !action ||
      typeof action !== "object" ||
      Array.isArray(action) ||
      typeof action.kind !== "string" ||
      !Object.hasOwn(action, "kind") ||
      !Object.hasOwn(action, "target") ||
      !Object.hasOwn(actionLabels, action.kind) ||
      typeof action.target !== "string"
    )
      return;
    actions.push({
      kind: action.kind,
      label: actionLabels[action.kind],
      target: action.target,
      planId: plan.id,
    });
  }
  return actions;
}

type StepEvent = { step: number; fence: number; outcome: string; at: string };
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function capturedEvents(raw: unknown): StepEvent[] | undefined {
  // The existing endpoint returns at most 1000 rows, in persisted event order.
  if (!Array.isArray(raw) || raw.length > 1000) return;
  const events: StepEvent[] = [];
  for (let index = 0; index < raw.length; index++) {
    if (!Object.hasOwn(raw, index)) return;
    const value: unknown = raw[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (!["step", "fence", "outcome", "at"].every((key) => Object.hasOwn(row, key))) return;
    const { step, fence, outcome, at } = row;
    if (
      !counter(step) ||
      step === Number.MAX_SAFE_INTEGER ||
      !counter(fence) ||
      typeof outcome !== "string" ||
      typeof at !== "string"
    )
      return;
    // Capture exact scalar values, so later source-object edits cannot mix pages.
    events.push({ step, fence, outcome, at });
  }
  return events;
}

export function renderOperationStepHistory(
  raw: unknown,
  operationId: string,
  isCurrent: () => boolean,
  originalContext?: OriginalContext,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "operation-step-history";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Recorded step history");
  root.append(text("h4", "Recorded step history"));
  const events = capturedEvents(raw);
  if (typeof operationId !== "string" || operationId.length === 0 || !events) {
    root.append(
      text(
        "p",
        "Readable step history unavailable. Inspect again; the original response remains in technical step events.",
      ),
    );
    return root;
  }
  root.dataset.operationId = operationId;
  root.append(
    text(
      "p",
      "Scope inherited from the selected operation request. Repeated steps and returned order are retained; these are not connectivity measurements or remote execution guarantees.",
    ),
  );
  if (events.length === 0) {
    root.append(
      text(
        "p",
        "No step events in this bounded response; this does not establish that no execution occurred.",
      ),
    );
    return root;
  }
  const records = events;
  const actions = capturedActions(originalContext, operationId);
  root.append(
    text(
      "p",
      "Requested action context is from the original plan, not evidence that this action executed. Reported outcomes remain separate.",
    ),
  );
  const count = text("p", "");
  const list = document.createElement("ol");
  const more = text("button", "Show more returned step events");
  more.type = "button";
  let shown = 0;
  function append() {
    const end = Math.min(records.length, shown + 20);
    while (shown < end) {
      const index = shown++,
        event = records[index];
      const row = document.createElement("li");
      row.value = index + 1;
      row.dataset.eventIndex = String(index);
      row.dataset.stepIndex = String(event.step);
      const action = actions?.[event.step];
      if (action) {
        const requested = document.createElement("div");
        requested.dataset.requestedAction = "";
        requested.dataset.planId = action.planId;
        requested.dataset.actionKind = action.kind;
        requested.append(
          text("p", "Requested action from original plan"),
          text("strong", action.label),
          document.createTextNode(" · "),
          text("code", action.target.length ? action.target : '"" (empty string)'),
        );
        row.append(requested);
      } else row.append(text("p", "Original requested action unavailable in returned history."));
      row.append(
        text("strong", `Step ${event.step + 1} · Fence ${event.fence}`),
        text(
          "p",
          event.outcome === "postcondition_verified_in_simulator"
            ? "Simulator postcondition recorded"
            : "Reported outcome",
        ),
        text("code", event.outcome.length ? event.outcome : '"" (empty string)'),
        text("p", `Reported timestamp: ${event.at.length ? event.at : '"" (empty string)'}`),
      );
      list.append(row);
    }
    count.textContent = `Showing ${shown} of ${records.length} returned events · bounded history, not the database total. Step labels are one-based; original indexes remain in technical JSON.`;
    more.disabled = shown === records.length;
  }
  more.onclick = () => {
    if (!more.disabled && root.isConnected && root.contains(more) && isCurrent()) append();
  };
  root.append(count, list, more);
  // Build the initial batch off-document; only retained user controls require current membership.
  append();
  return root;
}

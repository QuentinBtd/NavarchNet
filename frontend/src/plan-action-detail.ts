import type { ActionKind, Plan } from "./generated";
import { text } from "./view";

type CapturedAction = {
  kind: ActionKind;
  label: string;
  target: string;
  postcondition: string;
  requires: number[];
};
function capture(plan: Plan, labels: Readonly<Record<ActionKind, string>>) {
  if (!plan || !["id", "digest", "actions"].every((key) => Object.hasOwn(plan, key))) return;
  const { id, digest, actions } = plan;
  if (
    typeof id !== "string" ||
    !id ||
    typeof digest !== "string" ||
    !digest ||
    !Array.isArray(actions) ||
    actions.length > 1000
  )
    return;
  const rows: CapturedAction[] = [];
  let references = 0;
  for (let i = 0; i < actions.length; i++) {
    if (!Object.hasOwn(actions, i)) return;
    const action = actions[i];
    if (
      !action ||
      !["kind", "target", "requires", "postcondition"].every((key) => Object.hasOwn(action, key))
    )
      return;
    const { kind, target, requires, postcondition } = action;
    if (
      ![kind, target, postcondition].every((value) => typeof value === "string" && value.length <= 16384) ||
      !Array.isArray(requires)
    )
      return;
    references += requires.length;
    if (references > 10000) return;
    const dependencies: number[] = [];
    for (let j = 0; j < requires.length; j++) {
      if (!Object.hasOwn(requires, j)) return;
      const dependency = requires[j];
      if (
        typeof dependency !== "number" ||
        !Number.isSafeInteger(dependency) ||
        dependency < 0 ||
        dependency >= actions.length
      )
        return;
      dependencies.push(dependency);
    }
    rows.push({
      kind,
      label: Object.hasOwn(labels, kind) && typeof labels[kind] === "string" ? labels[kind] : kind,
      target,
      postcondition,
      requires: dependencies,
    });
  }
  return { id, digest, rows };
}

// Captured requested intent only; no execution state, API, form mutation or parent action callback.
export function renderPlanActionDetail(
  plan: Plan,
  labels: Readonly<Record<ActionKind, string>>,
  isCurrent: () => boolean,
): HTMLElement {
  const root = document.createElement("section");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Requested action detail");
  const captured = capture(plan, labels);
  if (!captured) {
    root.append(
      text(
        "p",
        "Requested actions unavailable or exceed local display limits. Original technical evidence is unchanged.",
      ),
    );
    return root;
  }
  root.dataset.planId = captured.id;
  root.dataset.planDigest = captured.digest;
  root.append(
    text("h4", "Inspect proposed actions"),
    text(
      "p",
      "Original requested intent, not evidence of execution. A required postcondition is not an observed result.",
    ),
  );
  if (!captured.rows.length) {
    root.append(text("p", "No requested actions returned."));
    return root;
  }
  const detail = document.createElement("div");
  const previous = text("button", "Previous proposed action");
  const next = text("button", "Next proposed action");
  previous.type = next.type = "button";
  const value = (literal: string) => (literal === "" ? '"" (empty string)' : literal);
  let index = 0;
  let generation = 0;
  const current = (control: HTMLButtonElement) =>
    root.isConnected && control.isConnected && root.contains(control) && !control.disabled && isCurrent();
  const draw = () => {
    const row = captured.rows[index];
    if (!row) return;
    const drawGeneration = ++generation;
    root.dataset.actionIndex = String(index);
    const kind = text("strong", value(row.label));
    kind.dataset.proposedKind = row.kind;
    const target = text("code", value(row.target));
    target.dataset.proposedTarget = "";
    const postcondition = text("dd", value(row.postcondition));
    postcondition.dataset.requiredPostcondition = "";
    const fields = document.createElement("dl");
    const targetValue = document.createElement("dd");
    targetValue.append(target);
    const dependencies = document.createElement("dd");
    if (!row.requires.length) dependencies.append(text("span", "None requested."));
    for (const required of row.requires) {
      const inspect = text("button", `Inspect requested step ${required + 1}`);
      inspect.type = "button";
      inspect.dataset.requiredIndex = String(required);
      inspect.onclick = () => {
        if (generation !== drawGeneration || !detail.contains(inspect) || !current(inspect)) return;
        index = required;
        draw();
      };
      dependencies.append(inspect);
    }
    fields.append(
      text("dt", "Original target"),
      targetValue,
      text("dt", "Required postcondition"),
      postcondition,
      text("dt", "Required steps (original indexes, displayed one-based)"),
      dependencies,
    );
    detail.replaceChildren(
      text("h4", `Requested step ${index + 1} of ${captured.rows.length}`),
      kind,
      fields,
    );
    previous.disabled = index === 0;
    next.disabled = index === captured.rows.length - 1;
  };
  previous.onclick = () => {
    if (!current(previous) || index <= 0) return;
    index--;
    draw();
  };
  next.onclick = () => {
    if (!current(next) || index >= captured.rows.length - 1) return;
    index++;
    draw();
  };
  root.append(detail, previous, next);
  draw();
  return root;
}

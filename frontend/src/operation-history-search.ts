import type { Operation } from "./generated";
import { text } from "./view";

export type OperationSearchState = { query: string };
const fields = ["id", "plan_id", "scope", "status"] as const;

// Presentation-only capture limits, not endpoint quotas or CPU/deadline guarantees.
export function operationHistorySearch(
  root: HTMLElement,
  select: HTMLSelectElement,
  operations: Operation[],
  selectedId: string | undefined,
  isCurrent: () => boolean,
  state: OperationSearchState,
) {
  const controls = document.createElement("div");
  const label = text("label", "Search returned operations");
  const input = document.createElement("input");
  input.id = "operation-history-search";
  label.htmlFor = input.id;
  input.type = "search";
  input.maxLength = 256;
  input.value = state.query;

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  controls.append(
    label,
    input,

    text(
      "p",
      "Literal, case-sensitive ID, plan ID, scope or status. Returned history only; search never selects or inspects an operation.",
    ),
    status,
  );
  const rows: { operation: Operation; values: string[]; option: HTMLOptionElement }[] = [];
  let captureValid = Array.isArray(operations) && operations.length <= 1000;
  let total = 0;
  const ids = new Set<string>();
  if (captureValid) {
    for (let i = 0; i < operations.length; i++) {
      const operation = operations[i],
        option = select.options[i];
      if (
        !Object.hasOwn(operations, i) ||
        !operation ||
        !option ||
        fields.some(
          (field) =>
            !Object.hasOwn(operation, field) ||
            typeof operation[field] !== "string" ||
            operation[field].length > 16384,
        )
      ) {
        captureValid = false;
        break;
      }
      const values = fields.map((field) => operation[field]);
      total += values.reduce((sum, value) => sum + value.length, 0);
      if (!operation.id || ids.has(operation.id) || total > 1048576) {
        captureValid = false;
        break;
      }
      ids.add(operation.id);
      rows.push({ operation, values, option });
    }
  }
  const sourceCurrent = () =>
    captureValid &&
    operations.length === rows.length &&
    rows.every(
      (row, i) =>
        Object.hasOwn(operations, i) &&
        operations[i] === row.operation &&
        fields.every(
          (field, j) => Object.hasOwn(row.operation, field) && row.operation[field] === row.values[j],
        ),
    );
  let visible = new Set<string>();
  function draw(query: string) {
    visible = new Set();
    select.replaceChildren();
    select.disabled = true;
    if (query.length > 256 || !sourceCurrent()) {
      status.textContent =
        "Operation search unavailable: query exceeds 256 characters or returned search fields changed, are ambiguous or exceed local capture limits. Clear the query or Refresh; selected detail is unchanged.";
      return;
    }
    const matches = rows.filter((row) => row.values.some((value) => value.includes(query)));
    select.append(...matches.map((row) => row.option));
    visible = new Set(matches.map((row) => row.values[0] ?? ""));
    select.value = selectedId ?? "";
    select.disabled = matches.length === 0;
    status.textContent = `${matches.length} of ${rows.length} returned operations match. ${visible.has(selectedId ?? "") ? "Selected detail is unchanged." : "Selected operation is outside search results; its detail is unchanged."}`;
  }
  const currentControl = (control: HTMLElement) =>
    root.isConnected &&
    controls.parentElement === root &&
    control.parentElement === controls &&
    select.parentElement === root &&
    isCurrent();
  input.oninput = () => {
    if (input.disabled || !currentControl(input)) return;
    state.query = input.value;
    draw(input.value);
  };

  draw(state.query);
  return { controls, canSelect: (id: string) => sourceCurrent() && visible.has(id) };
}

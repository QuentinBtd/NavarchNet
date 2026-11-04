import type { Plan } from "./generated";
import { text } from "./view";

export type PlanSearchState = { query: string };
// Original Plan fields only: never enrich immutable intent with current inventory.
function searchValues(plan: Plan): string[] | undefined {
  if (
    !plan ||
    !["id", "scope", "request"].every((key) => Object.hasOwn(plan, key)) ||
    !plan.request ||
    typeof plan.request !== "object" ||
    Array.isArray(plan.request)
  )
    return;
  if (!["account_id", "vpc_id", "network_id"].every((key) => Object.hasOwn(plan.request, key))) return;
  const values = [plan.id, plan.scope, plan.request.account_id, plan.request.vpc_id, plan.request.network_id];
  return values.every((value) => typeof value === "string" && value.length <= 16384) && plan.id.length > 0
    ? values
    : undefined;
}

// Local presentation caps, not endpoint/cloud quotas or CPU/deadline guarantees.
export function planHistorySearch(
  root: HTMLElement,
  select: HTMLSelectElement,
  plans: Plan[],
  selectedId: string | undefined,
  isCurrent: () => boolean,
  state: PlanSearchState,
) {
  const controls = document.createElement("div"),
    input = document.createElement("input"),
    label = text("label", "Search returned plans"),
    status = document.createElement("p");
  input.id = "plan-history-search";
  label.htmlFor = input.id;
  input.type = "search";
  input.maxLength = 256;
  input.value = state.query;
  status.setAttribute("role", "status");
  controls.append(
    label,
    input,
    text(
      "p",
      "Literal, case-sensitive original plan ID, scope, account, VPC or network ID. Returned history only; search never selects, generates or applies a plan.",
    ),
    status,
  );
  const rows: { plan: Plan; request: Plan["request"]; values: string[]; option: HTMLOptionElement }[] = [];
  let valid = Array.isArray(plans) && plans.length <= 1000,
    total = 0;
  const ids = new Set<string>();
  if (valid)
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i],
        option = select.options[i],
        values = plan && searchValues(plan);
      if (!Object.hasOwn(plans, i) || !plan || !option || !values) {
        valid = false;
        break;
      }
      total += values.reduce((sum, value) => sum + value.length, 0);
      if (ids.has(plan.id) || total > 1048576) {
        valid = false;
        break;
      }
      ids.add(plan.id);
      rows.push({ plan, request: plan.request, values, option });
    }
  const sourceCurrent = () =>
    valid &&
    plans.length === rows.length &&
    rows.every((row, i) => {
      if (!Object.hasOwn(plans, i) || plans[i] !== row.plan || row.plan.request !== row.request) return false;
      const values = searchValues(row.plan);
      return !!values && values.every((value, index) => value === row.values[index]);
    });
  let visible = new Set<string>();
  function draw(query: string) {
    visible = new Set();
    select.replaceChildren();
    select.disabled = true;
    if (query.length > 256 || !sourceCurrent()) {
      status.textContent =
        "Plan search unavailable: query exceeds 256 characters or original search fields changed, are ambiguous or exceed local capture limits. Clear the query or Refresh; original selected detail is unchanged.";
      return;
    }
    const matches = rows.filter((row) => row.values.some((value) => value.includes(query)));
    select.append(...matches.map((row) => row.option));
    visible = new Set(matches.map((row) => row.values[0] ?? ""));
    select.value = selectedId ?? "";
    select.disabled = matches.length === 0;
    status.textContent = `${matches.length} of ${rows.length} returned plans match. ${visible.has(selectedId ?? "") ? "Original selected detail is unchanged." : "Selected plan is outside search results; its original detail is unchanged."}`;
  }
  input.oninput = () => {
    if (
      input.disabled ||
      !root.isConnected ||
      controls.parentElement !== root ||
      input.parentElement !== controls ||
      select.parentElement !== root ||
      !isCurrent()
    )
      return;
    state.query = input.value;
    draw(input.value);
  };
  draw(state.query);
  return { controls, canSelect: (id: string) => sourceCurrent() && visible.has(id) };
}

import { afterEach, expect, it, vi } from "vitest";
import type { Operation } from "./generated";
import { renderOperationReview } from "./operation-review-view";

afterEach(() => document.body.replaceChildren());
const operation = (id: string, status: string): Operation => ({
  id,
  status,
  plan_id: `plan-${id}`,
  scope: "scope",
  step: 2,
  attempts: 1,
  error: "<script>Conflicting manual route</script>",
  fault: "partial_failure",
});
it.each(["partial", "failed"])(
  "explains manual recovery for selected %s without acting or rewriting evidence",
  (status) => {
    const values = [operation("complete", "succeeded"), operation("partial", status)];
    const before = structuredClone(values),
      onSelect = vi.fn(),
      inspect = vi.fn(),
      drift = vi.fn(),
      review = vi.fn();
    const node = renderOperationReview(values, [], {
      selectedOperationId: "partial",
      isCurrent: () => true,
      onSelect,
      makeInspect: () => {
        const b = document.createElement("button");
        b.textContent = "Inspect result & step events";
        b.onclick = inspect;
        return b;
      },
      makeDrift: () => {
        const b = document.createElement("button");
        b.onclick = drift;
        return b;
      },
      onReviewPlan: review,
    });
    document.body.append(node);
    const guide = node.querySelector('[aria-label="Manual recovery guidance"]');
    expect(guide).not.toBeNull();
    expect(guide?.textContent).toContain(
      status === "partial" ? "Partial completion was reported" : "Failure was reported",
    );
    expect(guide?.textContent).toContain("not proof that earlier changes were undone");
    expect(guide?.textContent).toContain("Review original plan");
    expect(guide?.textContent).toContain("Inspect result & step events");
    expect(guide?.textContent).toContain("does not retry, roll back or repair");
    expect(guide?.querySelectorAll("button, a, input, select, form, script, img")).toHaveLength(0);
    expect(node.querySelector("script, img")).toBeNull();
    expect(JSON.parse(node.querySelector("pre")?.textContent ?? "null")).toEqual(values[1]);
    expect(values).toEqual(before);
    expect(onSelect).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(drift).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  },
);

it("limits recovery context to the exact selected failed or partial record, leaving other states and ambiguous history unknown", () => {
  const activate = vi.fn(),
    select = vi.fn();
  const mount = (rows: Operation[], selectedOperationId: string) => {
    const node = renderOperationReview(rows, [], {
      selectedOperationId,
      isCurrent: () => true,
      onSelect: select,
      makeInspect: () => {
        const button = document.createElement("button");
        button.onclick = activate;
        return button;
      },
    });
    document.body.replaceChildren(node);
    return node;
  };
  for (const status of [
    "queued",
    "running",
    "retrying",
    "succeeded",
    "unknown",
    "Partial",
    "failed ",
    "",
    "<img src=x onerror=alert(1)>",
  ]) {
    const row = operation("selected", status),
      rows = [operation("other", "partial"), row],
      before = structuredClone(rows);
    const node = mount(rows, row.id);
    expect(node.querySelector('[aria-label="Manual recovery guidance"]')).toBeNull();
    expect(node.querySelector("script, img")).toBeNull();
    expect(JSON.parse(node.querySelector("pre")?.textContent ?? "null")).toEqual(row);
    expect(rows).toEqual(before);
  }
  for (const rows of [
    [],
    [operation("other", "partial")],
    [operation("selected", "partial"), operation("selected", "failed")],
  ]) {
    const node = mount(rows, "selected");
    expect(node.querySelector("article")).toBeNull();
    expect(node.querySelector('[aria-label="Manual recovery guidance"]')).toBeNull();
  }
  const node = mount([operation("selected", "failed")], "selected");
  expect(node.querySelector('[aria-label="Manual recovery guidance"]')?.textContent).toContain(
    "If unavailable in returned history, do not substitute another plan",
  );
  expect(node.textContent).toContain("plan total unavailable");
  expect(activate).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

import { text } from "./view";

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

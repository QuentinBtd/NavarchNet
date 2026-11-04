import type { Observation, Operation } from "./generated";
import { operationReviewHref } from "./operation-review-link";
import { text } from "./view";

// Captured parsed JSON from separate sources, not an atomic snapshot or a measurement.
export function renderOperationInspectionExport(
  operation: Operation,
  observation: Observation,
  events: unknown,
  isCurrent: () => boolean,
): HTMLElement {
  const root = document.createElement("div");
  let recordJson: string, observationJson: string, eventsJson: string, captured: string;
  const id = operation?.id;
  try {
    if (!operationReviewHref(id) || observation?.operation_id !== id) throw new Error("Identity unavailable");
    recordJson = JSON.stringify(operation);
    observationJson = JSON.stringify(observation);
    eventsJson = JSON.stringify(events);
    captured = JSON.stringify(
      {
        format: "navarchnet.operation-inspection.v1",
        operation_snapshot: JSON.parse(recordJson),
        observation: JSON.parse(observationJson),
        events: JSON.parse(eventsJson),
        provenance: {
          operation_snapshot: "Authenticated returned snapshot",
          observation: "Explicit operation-scoped GET",
          events: "Explicit operation-scoped GET; row identity inherited from request",
          atomic_capture: false,
          connectivity: "No measurement inferred by this export",
        },
      },
      null,
      2,
    );
    // A local artifact cap, not an endpoint/cloud quota; excess is never silently truncated.
    if (new TextEncoder().encode(captured).byteLength > 4 * 1024 * 1024) throw new Error("Capture too large");
  } catch {
    root.append(text("p", "Inspection export unavailable for this captured data."));
    return root;
  }
  root.dataset.operationId = id;
  const download = text("button", "Download captured inspection JSON");
  download.type = "button";
  download.dataset.operationExport = "";
  download.onclick = () => {
    try {
      if (
        download.disabled ||
        !root.isConnected ||
        download.parentElement !== root ||
        !isCurrent() ||
        operation.id !== id ||
        observation.operation_id !== id ||
        JSON.stringify(operation) !== recordJson ||
        JSON.stringify(observation) !== observationJson ||
        JSON.stringify(events) !== eventsJson
      )
        return;
    } catch {
      return;
    }
    const url = URL.createObjectURL(new Blob([captured], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "navarchnet-operation-inspection.json";
    link.hidden = true;
    root.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };
  root.append(
    download,
    text(
      "p",
      "Captured snapshot record and separate operation-scoped reads; not atomic or a connectivity measurement.",
    ),
  );
  return root;
}

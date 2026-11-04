import type { Observation } from "./generated";

export function operationLabel(status: string, step: number, total: number): string {
  const label =
    status === "succeeded"
      ? "Simulation converged"
      : status === "partial"
        ? "Partial completion — manual review required"
        : status;
  return `${label} · ${step}/${total} steps`;
}

export function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

export function renderObservation(value: Observation): HTMLElement {
  const node = document.createElement("section");
  node.append(text("h3", "Observed configuration, not measured connectivity"));
  const list = document.createElement("dl");
  for (const [label, detail] of Object.entries({
    Configuration: value.configuration,
    "Calculated path": value.calculated_path,
    "Example public egress IPs (simulation)": value.public_ips.join(", "),
    "Allowed connectivity": value.connectivity,
    "Active measurement": value.active_probe,
    Drift: value.drift ? "Detected — no automatic repair" : "No simulated drift detected",
    Recovery: value.recovery,
  })) {
    list.append(text("dt", label), text("dd", detail));
  }
  node.append(list);
  return node;
}

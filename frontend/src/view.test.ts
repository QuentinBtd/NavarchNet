import { describe, expect, it } from "vitest";
import type { Observation } from "./generated";
import { operationLabel, renderObservation } from "./view";

describe("truthful operation and connectivity presentation", () => {
  it("never calls simulated convergence healthy", () => {
    expect(operationLabel("succeeded", 7, 7)).toBe("Simulation converged · 7/7 steps");
    expect(operationLabel("partial", 3, 7)).toContain("Partial completion");
  });
  it("renders hostile provider text as text, and separates measurements", () => {
    const observation: Observation = {
      operation_id: "x",
      configuration: "simulated_converged",
      calculated_path: "<img src=x onerror=alert(1)>",
      public_ips: ["192.0.2.10"],
      connectivity: "Isolated",
      active_probe: "Not tested",
      drift: false,
      recovery: "Review steps",
    };
    const node = renderObservation(observation);
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain(observation.calculated_path);
    expect(node.textContent).toContain("Not tested");
    expect(node.textContent).toContain("192.0.2.10");
  });
});

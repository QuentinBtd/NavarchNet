import type { RegionalNetwork } from "./generated";
import { text } from "./view";

// Current configuration context only, not a historical plan or measured egress.
export function renderConnectionNetworkContext(networks: RegionalNetwork[], selectedId: string): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Selected regional network");
  const unavailable = () => {
    root.append(text("p", "Selected network context unavailable or ambiguous. Refresh the snapshot."));
    return root;
  };
  if (!Array.isArray(networks)) return unavailable();
  for (let i = 0; i < networks.length; i++) {
    if (!Object.hasOwn(networks, i)) return unavailable();
    const network = networks[i];
    if (!network || typeof network.id !== "string" || network.id.length === 0) return unavailable();
  }
  const matches = networks.filter((network) => network.id === selectedId);
  const network = matches.length === 1 ? matches[0] : undefined;
  if (
    !network ||
    ![network.name, network.region, network.egress_cidr].every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !Number.isSafeInteger(network.revision) ||
    network.revision < 0
  )
    return unavailable();
  root.dataset.networkId = network.id;
  const description = document.createElement("p");
  description.append(
    text("strong", network.name),
    document.createTextNode(` · ${network.region} · declared egress CIDR ${network.egress_cidr}`),
  );
  root.append(
    description,
    text(
      "small",
      `Snapshot revision ${network.revision} · declared simulation network, not measured egress.`,
    ),
  );
  return root;
}

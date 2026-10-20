import type { TgwLookupRequest, TgwLookupResponse } from "./generated";
import { text } from "./view";

export type SavedLookup = (query: TgwLookupRequest) => Promise<TgwLookupResponse | undefined>;
export function renderTgwLookup(
  topologyId: string,
  tableId: string,
  index: number,
  lookup: SavedLookup,
): HTMLFormElement {
  const form = document.createElement("form");
  form.dataset.routeLookup = tableId;
  const label = text("label", "Destination IP (saved TGW table lookup)");
  const input = document.createElement("input");
  input.id = `aws-tgw-lookup-${index}`;
  label.htmlFor = input.id;
  input.required = true;
  input.maxLength = 64;
  input.placeholder = "203.0.113.1 or 2001:db8::1";
  const submit = text("button", "Look up saved TGW route");
  submit.type = "submit";
  const output = text("p", "Offline table lookup only; not a full path or measured connectivity.");
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");
  form.append(label, input, submit, output);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const query = { route_table_id: tableId, destination: input.value };
    submit.disabled = true;
    input.disabled = true;
    output.textContent = "Reading saved table observation…";
    void (async () => {
      try {
        const value = await lookup(query);
        if (!value) {
          output.textContent = "Lookup discarded; view or session changed.";
          return;
        }
        if (value.topology_id !== topologyId) {
          output.textContent = "Snapshot changed; refresh the saved observation before another lookup.";
          return;
        }
        if (
          value.route_table_id !== tableId ||
          value.destination !== query.destination ||
          value.execution_enabled ||
          value.connectivity_tested
        )
          throw new Error("Lookup response did not match the requested observation scope");
        const result = value.result;
        const description =
          result.status === "reported_forward"
            ? `Reported table match: ${value.destination} → ${result.destination_cidr} · ${result.route_type} · attachments: ${result.attachment_ids.join(", ")}`
            : result.status === "reported_blackhole"
              ? `Reported blackhole: ${value.destination} → ${result.destination_cidr}`
              : `Unresolved: ${result.reason}`;
        output.textContent = `${description}. Saved observation only; not a full path or measured connectivity.`;
      } catch (error) {
        output.textContent = error instanceof Error ? error.message : "Saved lookup failed";
      } finally {
        submit.disabled = false;
        input.disabled = false;
      }
    })();
  };
  return form;
}

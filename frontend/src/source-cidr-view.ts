import type {
  AwsTopology,
  SourceHandoffCidrCoverage,
  SourceHandoffCidrQuery,
  VerifiedAccount,
} from "./generated";
import { validateSourceCidr } from "./source-cidr-contract";
import { text } from "./view";

export type SourceCidrContext = Pick<
  AwsTopology,
  | "id"
  | "account_id"
  | "aws_account_id"
  | "region"
  | "started_at"
  | "completed_at"
  | "session_name"
  | "request_ids"
  | "complete_for_supported_queries"
  | "limitations"
  | "execution_enabled"
  | "connectivity_tested"
>;
export type SavedSourceCidr = (
  query: Omit<SourceHandoffCidrQuery, "source_account_id">,
) => Promise<SourceHandoffCidrCoverage | undefined>;
const caveat =
  "Independent saved decisions, not a validated path. No host membership, target health, receiving AZ, return path, authority or connectivity is established. No cloud calls or follow-up reads.";
export function captureSourceCidrContext(source: SourceCidrContext): SourceCidrContext {
  const {
    id,
    account_id,
    aws_account_id,
    region,
    started_at,
    completed_at,
    session_name,
    request_ids,
    complete_for_supported_queries,
    limitations,
    execution_enabled,
    connectivity_tested,
  } = source;
  return structuredClone({
    id,
    account_id,
    aws_account_id,
    region,
    started_at,
    completed_at,
    session_name,
    request_ids,
    complete_for_supported_queries,
    limitations,
    execution_enabled,
    connectivity_tested,
  });
}
// Each collection, including maps and nested provider arrays, has a complete local
// continuation. No full resource/topology JSON is materialized into a default row.
function lazyEvidence(
  label: string,
  value: unknown,
  owner: HTMLElement,
  current: () => boolean,
  intervals = false,
): HTMLElement {
  if (value === null || typeof value !== "object") return text("span", `${label}: ${JSON.stringify(value)}`);
  const detail = document.createElement("details");
  detail.dataset.sourceCidrEvidence = label;
  if (intervals) detail.dataset.sourceCidrIntervals = "";
  const isArray = Array.isArray(value);
  const keys = isArray ? undefined : Object.keys(value);
  const length = isArray ? value.length : (keys?.length ?? 0);
  detail.append(text("summary", `${label} (${length})`));
  let shown = 0,
    started = false;
  const list = document.createElement("ul"),
    count = text("p", ""),
    more = text("button", "Show more saved evidence");
  more.type = "button";
  const append = () => {
    if (!current() || !owner.contains(detail)) return;
    const end = Math.min(shown + 50, length);
    for (; shown < end; shown++) {
      const key = isArray ? shown : keys?.[shown];
      if (key === undefined) continue;
      const entry = (value as Record<string | number, unknown>)[key];
      const item = document.createElement("li");
      if (intervals) {
        const segment = entry as SourceHandoffCidrCoverage["segments"][number];
        item.dataset.sourceCidrInterval = "";
        item.append(
          text("p", `Original index ${shown}: ${segment.start} – ${segment.end_inclusive} (inclusive)`),
          lazyEvidence("Saved decision", segment.result, owner, current),
        );
      } else
        item.append(lazyEvidence(isArray ? `Original index ${shown}` : String(key), entry, owner, current));
      list.append(item);
    }
    count.textContent = `Showing ${shown} of ${length} returned entries. Local display batches, not an AWS quota.`;
    more.hidden = shown === length;
  };
  more.onclick = append;
  detail.ontoggle = () => {
    if (!detail.open || started || !current() || !owner.contains(detail)) return;
    started = true;
    detail.append(count, list, more);
    append();
  };
  return detail;
}
export function renderSourceCidr(
  context: SourceCidrContext,
  subnetId: string,
  index: number,
  form: HTMLFormElement,
  network: HTMLSelectElement,
  lookup: SavedSourceCidr,
  isCurrent: () => boolean,
  accounts: readonly (Pick<VerifiedAccount, "id" | "region"> &
    Partial<Pick<VerifiedAccount, "aws_account_id">>)[],
): HTMLDetailsElement {
  const snapshot = captureSourceCidrContext(context);
  const registrations = accounts.map(({ id, aws_account_id, region }) => ({ id, aws_account_id, region }));
  const detail = document.createElement("details");
  detail.dataset.sourceCidr = subnetId;
  detail.append(text("summary", "Inspect saved source-to-TGW CIDR decisions"));
  let initialized = false;
  detail.ontoggle = () => {
    if (!detail.open || initialized || !isCurrent() || !form.contains(detail)) return;
    initialized = true;
    const label = text("label", "Destination CIDR (source-to-TGW decisions)");
    const input = document.createElement("input");
    input.id = `aws-source-cidr-${index}`;
    label.htmlFor = input.id;
    input.maxLength = 64;
    input.onkeydown = (event) => {
      if (event.key === "Enter") event.preventDefault();
    };
    const button = text("button", "Inspect saved CIDR decisions");
    button.type = "button";
    const status = text("p", caveat);
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const evidence = document.createElement("div");
    detail.append(label, input, button, status, evidence);
    let generation = 0,
      inputRevision = 0,
      parentRevision = 0;
    const retire = () => {
      generation++;
      evidence.replaceChildren();
      button.disabled = input.disabled = false;
      status.textContent = `Inputs changed; run another saved CIDR inspection. ${caveat}`;
    };
    input.oninput = input.onchange = () => {
      inputRevision++;
      retire();
    };
    const parentChanged = (event: Event) => {
      if (event.target instanceof Node && detail.contains(event.target)) return;
      parentRevision++;
      retire();
    };
    form.addEventListener("input", parentChanged);
    form.addEventListener("change", parentChanged);
    form.addEventListener(
      "submit",
      () => {
        parentRevision++;
        retire();
      },
      true,
    );
    button.onclick = () => {
      if (button.disabled || !isCurrent() || !form.contains(detail)) return;
      retire();
      if (!input.value || new TextEncoder().encode(input.value).length > 64 || !network.value) {
        status.textContent = `Select a saved network registration and enter a literal destination CIDR (maximum 64 UTF-8 bytes); canonical validation belongs to the server. ${caveat}`;
        return;
      }
      const query = { network_account_id: network.value, subnet_id: subnetId, destination_cidr: input.value };
      const selected = registrations.filter((r) => r.id === query.network_account_id);
      const registration = selected.length === 1 ? selected[0] : undefined;
      if (!registration || typeof registration.aws_account_id !== "string" || !registration.aws_account_id) {
        status.textContent = `CIDR inspection unavailable: a unique saved network registration with its literal AWS account and region is required. ${caveat}`;
        return;
      }
      const networkCapture = {
        id: registration.id,
        aws_account_id: registration.aws_account_id,
        region: registration.region,
      };
      const version = ++generation,
        revision = inputRevision,
        parent = parentRevision;
      const point = form.querySelector("input")?.value;
      const current = () => {
        if (generation !== version || !isCurrent() || !form.contains(detail)) return false;
        if (
          revision !== inputRevision ||
          parent !== parentRevision ||
          input.value !== query.destination_cidr ||
          network.value !== query.network_account_id ||
          form.querySelector("input")?.value !== point
        ) {
          retire();
          return false;
        }
        return true;
      };
      button.disabled = input.disabled = true;
      status.textContent = "Reading saved source-to-TGW CIDR decisions…";
      void (async () => {
        try {
          const response = await lookup(query);
          if (!current()) return;
          if (!response) {
            status.textContent = `Inspection discarded; refresh the saved view or retry. ${caveat}`;
            return;
          }
          const value = structuredClone(response);
          validateSourceCidr(value, snapshot, networkCapture, {
            source_account_id: snapshot.account_id,
            ...query,
          });
          const describe = (side: string, saved: SourceHandoffCidrCoverage["source_saved"]) =>
            `${side} registration ${saved.registration.id}, AWS account ${saved.registration.aws_account_id}, region ${saved.registration.region}; observation ${saved.saved_row_id}, generation ${saved.generation}, started ${saved.topology.started_at}, completed ${saved.topology.completed_at}; supported-query complete ${saved.topology.complete_for_supported_queries}; ${saved.topology.resources.length} resource records, ${saved.topology.request_ids.length} request IDs, ${saved.topology.limitations.length} limitations`;
          const summary = text(
            "p",
            `${describe("Source", value.source_saved)}. ${describe("Network", value.network_saved)}. ${value.segments.length} inclusive decision intervals, ${value.origins.length} original cut origins. Independent capture times, no simultaneous-snapshot or freshness claim. ${caveat}`,
          );
          summary.dataset.sourceCidrSummary = "";
          const staged = document.createDocumentFragment();
          staged.append(
            summary,
            lazyEvidence("Decision intervals", value.segments, evidence, current, true),
            lazyEvidence("Cut origins", value.origins, evidence, current),
          );
          for (const [side, saved] of [
            ["Source", value.source_saved],
            ["Network", value.network_saved],
          ] as const) {
            staged.append(
              lazyEvidence(`${side} registration`, saved.registration, evidence, current),
              lazyEvidence(`${side} request IDs`, saved.topology.request_ids, evidence, current),
              lazyEvidence(`${side} limitations`, saved.topology.limitations, evidence, current),
              lazyEvidence(`${side} resources`, saved.topology.resources, evidence, current),
              lazyEvidence(
                `${side} capture metadata`,
                { ...captureSourceCidrContext(saved.topology), admitted_bytes: saved.admitted_bytes },
                evidence,
                current,
              ),
            );
          }
          evidence.replaceChildren(staged);
          status.textContent = caveat;
        } catch (error) {
          if (current())
            status.textContent = `${error instanceof Error ? error.message : "Saved CIDR inspection failed"}. ${caveat}`;
        } finally {
          if (version === generation && isCurrent() && form.contains(detail)) {
            current();
            if (version === generation) button.disabled = input.disabled = false;
          }
        }
      })();
    };
  };
  return detail;
}

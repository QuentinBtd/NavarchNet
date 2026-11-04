import { text } from "./view";

// Saved response order and literal metadata only. There is no event ID or current-state join.
export function renderAuditTrail(value: unknown): HTMLElement {
  const root = document.createElement("section");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Returned audit trail");
  root.append(text("h3", "Returned audit trail"));
  const fields = ["actor", "event", "target", "at"] as const;
  const records: Record<(typeof fields)[number], string>[] = [];
  let valid = Array.isArray(value) && value.length <= 1000;
  if (Array.isArray(value) && valid) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        valid = false;
        break;
      }
      const record = value[index];
      if (!record || typeof record !== "object" || !fields.every((field) => Object.hasOwn(record, field))) {
        valid = false;
        break;
      }
      const captured = { actor: record.actor, event: record.event, target: record.target, at: record.at };
      if (!Object.values(captured).every((field) => typeof field === "string")) {
        valid = false;
        break;
      }
      records.push(captured);
    }
  }
  if (!valid) {
    root.append(
      text(
        "p",
        "Readable audit context unavailable or malformed. Inspect the complete returned JSON; no partial record prefix is shown.",
      ),
    );
    return root;
  }
  root.append(
    text(
      "p",
      `Showing ${Math.min(6, records.length)} of ${records.length} returned records · not the database total. Complete returned JSON is below.`,
    ),
    text(
      "p",
      "Saved records in returned order, not current operation state or connectivity measurements. Actors, events, targets and recorded times are literal metadata, not record links or a reconstructed execution history.",
    ),
  );
  if (records.length === 0)
    root.append(text("p", "No audit records returned. This is not proof of an empty database."));
  const list = document.createElement("ol");
  for (const [index, record] of records.slice(0, 6).entries()) {
    const row = document.createElement("li");
    row.dataset.auditIndex = String(index);
    const event = text("strong", record.event);
    event.dataset.auditField = "event";
    row.append(event);
    for (const [field, label] of [
      ["actor", "Actor"],
      ["target", "Target"],
      ["at", "Recorded at"],
    ] as const) {
      const line = text("p", `${label} · `),
        literal = text("code", record[field]);
      literal.dataset.auditField = field;
      line.append(literal);
      if (record[field] === "") line.append(text("span", " (reported empty string)"));
      row.append(line);
    }
    if (record.event === "") row.append(text("p", "Event is a reported empty string."));
    list.append(row);
  }
  root.append(list);
  return root;
}

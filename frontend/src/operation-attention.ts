import type { Operation } from "./generated";
import { operationReviewHref } from "./operation-review-link";
import { text } from "./view";

// Saved simulation statuses only, not current connection health or complete storage history.
export function renderOperationAttention(operations: Operation[], isCurrent: () => boolean): HTMLElement {
  const root = document.createElement("section");
  root.setAttribute("aria-label", "Returned operation attention");
  root.append(text("h3", "Returned operation attention"));
  let originalJson: string;
  try {
    if (!Array.isArray(operations)) throw new Error("Missing operations");
    const ids = new Set<string>();
    for (let i = 0; i < operations.length; i++) {
      if (!Object.hasOwn(operations, i)) throw new Error("Missing operation");
      const row = operations[i];
      if (
        !row ||
        !["id", "status", "scope", "error"].every((field) => Object.hasOwn(row, field)) ||
        ![row.id, row.status, row.scope].every((v) => typeof v === "string" && v.length > 0) ||
        (row.error !== null && typeof row.error !== "string") ||
        ids.has(row.id)
      )
        throw new Error("Ambiguous operation");
      ids.add(row.id);
    }
    originalJson = JSON.stringify(operations);
  } catch {
    root.append(text("p", "Returned operation attention unavailable or ambiguous. Refresh explicitly."));
    return root;
  }
  const attention = operations.filter((o) => o.status === "failed" || o.status === "partial");
  const active = operations.filter((o) => ["queued", "running", "retrying"].includes(o.status)).length;
  const succeeded = operations.filter((o) => o.status === "succeeded").length;
  root.append(
    text(
      "p",
      `${operations.length} returned operations · ${attention.length} failed/partial · ${active} queued/running/retrying · ${succeeded} succeeded · ${operations.length - attention.length - active - succeeded} other statuses.`,
    ),
  );
  root.append(
    text(
      "p",
      "Saved simulation statuses in bounded history, not connectivity or proof of rollback. Refresh explicitly for another snapshot.",
    ),
  );
  const current = (link: HTMLAnchorElement, href: string) => {
    try {
      return (
        root.isConnected &&
        root.contains(link) &&
        isCurrent() &&
        link.getAttribute("href") === href &&
        link.getAttribute("aria-disabled") !== "true" &&
        JSON.stringify(operations) === originalJson
      );
    } catch {
      return false;
    }
  };
  const list = document.createElement("ul");
  list.className = "compact-list";
  for (const operation of attention.slice(0, 6)) {
    const row = document.createElement("li");
    row.dataset.attentionOperation = operation.id;
    row.append(text("strong", operation.status), text("p", `Recorded scope: ${operation.scope}`));
    row.append(
      text(
        "p",
        operation.error === null
          ? "No error recorded."
          : operation.error === ""
            ? '"" (empty error string)'
            : operation.error,
      ),
    );
    const href = operationReviewHref(operation.id);
    if (href) {
      const link = text("a", `Review ${operation.status} operation`);
      link.href = href;
      link.onclick = (event) => {
        if (!current(link, href)) event.preventDefault();
      };
      row.append(link);
    } else row.append(text("p", "Exact review link unavailable for this literal identity."));
    list.append(row);
  }
  if (attention.length)
    root.append(
      list,
      text(
        "p",
        `Showing ${Math.min(6, attention.length)} of ${attention.length} returned failed/partial operations, in returned order.`,
      ),
    );
  else
    root.append(
      text(
        "p",
        "No failed/partial operation in this returned history; absence here does not establish health.",
      ),
    );
  const all = text("a", "Review all returned operations");
  all.href = "#/operations";
  all.onclick = (event) => {
    if (!current(all, "#/operations")) event.preventDefault();
  };
  root.append(all);
  return root;
}

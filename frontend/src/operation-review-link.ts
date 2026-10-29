import { planReviewHref, readPlanReviewIntent } from "./plan-review-link";

const prefix = "#/operations?operation=";
// Reuse the existing literal-ID codec, not a Plan lookup or form-query decoder.
export function operationReviewHref(id: unknown): string | undefined {
  const encoded = planReviewHref(id);
  return encoded ? prefix + encoded.slice("#/plans?plan=".length) : undefined;
}

type OperationReviewIntent =
  | { kind: "none" }
  | { kind: "invalid"; hash: "#/operations?operation=" }
  | { kind: "operation"; id: string; hash: string };

export function readOperationReviewIntent(hash: string): OperationReviewIntent {
  if (hash !== "#/operations?operation" && !hash.startsWith(prefix)) return { kind: "none" };
  const invalid: OperationReviewIntent = { kind: "invalid", hash: "#/operations?operation=" };
  // Bound the original fragment before substituting the shorter codec prefix.
  if (hash.length > 8192) return invalid;
  const intent = readPlanReviewIntent(`#/plans?plan=${hash.slice(prefix.length)}`);
  if (hash === "#/operations?operation" || intent.kind !== "plan") return invalid;
  const canonical = operationReviewHref(intent.id);
  return canonical ? { kind: "operation", id: intent.id, hash: canonical } : invalid;
}

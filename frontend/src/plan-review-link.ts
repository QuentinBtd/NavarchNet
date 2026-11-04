// Only an opaque internal Plan identity, never a token, request or provider record.
export function planReviewHref(id: unknown): string | undefined {
  if (typeof id !== "string" || id.length === 0 || id.length > 2048 || /\p{Cc}/u.test(id)) return;
  if (new TextEncoder().encode(id).byteLength > 2048) return;
  try {
    return `#/plans?plan=${encodeURIComponent(id)}`;
  } catch {
    // Reject malformed UTF-16 instead of repairing an identifier.
    return;
  }
}

type PlanReviewIntent =
  | { kind: "none" }
  | { kind: "invalid"; hash: "#/plans?plan=" }
  | { kind: "plan"; id: string; hash: string };

export function readPlanReviewIntent(hash: string): PlanReviewIntent {
  const prefix = "#/plans?plan=";
  if (hash !== "#/plans?plan" && !hash.startsWith(prefix)) return { kind: "none" };
  const invalid: PlanReviewIntent = { kind: "invalid", hash: "#/plans?plan=" };
  if (!hash.startsWith(prefix) || hash.length > 8192) return invalid;
  const raw = hash.slice(prefix.length);
  if (raw.includes("&")) return invalid;
  try {
    // Unlike form-query decoding, a literal '+' remains '+'; malformed escapes reject atomically.
    const id = decodeURIComponent(raw);
    const canonical = planReviewHref(id);
    return canonical ? { kind: "plan", id, hash: canonical } : invalid;
  } catch {
    return invalid;
  }
}

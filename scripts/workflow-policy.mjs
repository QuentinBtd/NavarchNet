import { readFileSync } from "node:fs";

export function validateWorkflow(source) {
  const events = source.match(/^on:\n((?:[ \t].*\n|\s*\n)*)/m)?.[1];
  if (!events) throw new Error("Expected an explicit on: event block");
  const names = [...events.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]);
  if (names.length !== 1 || names[0] !== "workflow_dispatch")
    throw new Error("Heavy validation must be workflow_dispatch-only; do not add automatic events");
  if (!/^permissions:\n  contents: read\n/m.test(source) || /^\s+[a-z-]+: write\s*$/m.test(source))
    throw new Error("Validation requires read-only workflow permissions");
  for (const [, action] of source.matchAll(/\buses:\s*(\S+)/g))
    if (!/^[\w-]+\/[\w.-]+@[a-f0-9]{40}$/.test(action))
      throw new Error("Every remote action must use an exact commit SHA");
  for (const task of ["check", "audit", "browser", "containers", "package"])
    if (!source.includes(`mise run ${task}`)) throw new Error(`Missing shared mise entry point: ${task}`);
}
export const workflow = () => readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

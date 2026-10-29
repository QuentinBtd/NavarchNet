import { readPlanReviewIntent } from "./plan-review-link";

const routes = {
  overview: "overview",
  accounts: "accounts",
  networks: "networks",
  connections: "connect",
  plans: "plans",
  operations: "operations",
  diagnostics: "diagnostics",
  aws: "aws",
} as const;
export type WorkspaceRoute = keyof typeof routes;

// Hash routes work with static serving; never encode tokens, account records or provider text.
export function createNavigation(root: HTMLElement, onNavigate: () => void) {
  const signIn = root.querySelector<HTMLElement>("#session");
  const actions = root.querySelector<HTMLElement>("#session-actions");
  const workspace = root.querySelector<HTMLElement>("#workspace");
  if (!signIn || !actions || !workspace) throw new Error("Navigation shell missing");
  let authenticated = false;
  let currentHash: string | undefined;
  function render() {
    if (!root.isConnected) {
      window.removeEventListener("hashchange", render);
      window.removeEventListener("popstate", render);
      return;
    }
    const raw = window.location.hash.slice(2);
    const intent = readPlanReviewIntent(window.location.hash);
    const route: WorkspaceRoute =
      intent.kind !== "none" ? "plans" : Object.hasOwn(routes, raw) ? (raw as WorkspaceRoute) : "overview";
    const hash = intent.kind !== "none" ? intent.hash : `#/${route}`;
    if (window.location.hash !== hash)
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    if (authenticated && currentHash !== undefined && currentHash !== hash) onNavigate();
    const changed = currentHash !== hash;
    currentHash = hash;
    for (const section of root.querySelectorAll<HTMLElement>("[data-workspace]")) {
      const hidden = !authenticated || section.id !== routes[route];
      section.hidden = hidden;
      section.inert = hidden;
    }
    for (const link of root.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Workspace"] a')) {
      const key = route === "plans" ? "connections" : route === "aws" ? "accounts" : route;
      if (link.hash === `#/${key}`) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (authenticated && changed) root.querySelector<HTMLElement>(`#${routes[route]} h2`)?.focus();
  }
  window.addEventListener("hashchange", render);
  window.addEventListener("popstate", render);
  render();
  return {
    authenticate(value: boolean) {
      authenticated = value;
      signIn.hidden = value;
      actions.hidden = !value;
      workspace.hidden = !value;
      render();
    },
    navigate(route: WorkspaceRoute) {
      if (window.location.hash !== `#/${route}`) window.history.pushState(null, "", `#/${route}`);
      render();
    },
  };
}

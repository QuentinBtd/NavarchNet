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
  let current: WorkspaceRoute | undefined;
  function render() {
    if (!root.isConnected) {
      window.removeEventListener("hashchange", render);
      window.removeEventListener("popstate", render);
      return;
    }
    const raw = window.location.hash.slice(2);
    const route: WorkspaceRoute = Object.hasOwn(routes, raw) ? (raw as WorkspaceRoute) : "overview";
    if (window.location.hash !== `#/${route}`)
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/${route}`);
    if (authenticated && current !== undefined && current !== route) onNavigate();
    const changed = current !== route;
    current = route;
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

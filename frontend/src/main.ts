import { renderAwsTopology } from "./aws-view";
import type {
  Account,
  ApplyPlan,
  ConnectionRequest,
  Fault,
  Inventory,
  NatReferenceResponse,
  Observation,
  Operation,
  Plan,
  RegisterAccount,
  RoleRegistration,
  Snapshot,
  TgwLookupResponse,
  TgwSourceResponse,
  TgwTargetResponse,
  TopologyView,
  VerifiedAccount,
  VpcLookupResponse,
} from "./generated";
import { Session } from "./session";
import { operationLabel, renderObservation, text } from "./view";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root missing");
// This template is static. All provider-controlled content uses textContent.
app.innerHTML = `
<header><div class="brand">N / NavarchNet</div><span>Self-hosted network control</span></header>
<main><section class="hero"><p class="eyebrow">REGIONAL NETWORK ORCHESTRATION</p><h1>Know where your traffic goes.</h1><p>Review the path. Apply an auditable plan. Inspect what actually converged.</p><p class="warning">Simulation and opt-in AWS read-only observations are separate. AWS execution and active connectivity testing are disabled.</p></section>
<section id="session"><h2>Operator session</h2><form id="login"><label for="token">Demo token or OIDC access token</label><div class="row"><input id="token" type="password" required autocomplete="off"><button>Connect</button><button id="logout" type="button">Sign out</button></div></form><p id="identity">Not authenticated. Tokens stay in memory only.</p></section>
<p id="notice" role="status" aria-live="polite"></p>
<div id="workspace" hidden><nav aria-label="Workspace"><a href="#overview">Overview</a><a href="#accounts">Accounts</a><a href="#aws">AWS observations</a><a href="#networks">Regional networks</a><a href="#connect">Connect VPC</a><a href="#plans">Plans</a><a href="#operations">Operations</a><a href="#diagnostics">Diagnostics</a><button id="refresh" type="button">Refresh</button></nav>
<section id="overview"><h2>Network overview</h2><p id="summary"></p><p>Policy v1: regional IPv4 egress, explicitly managed routes, application VPC isolation. Shared services, IPv6, inter-region fallback and active probes are not supported.</p></section>
<div class="grid"><section id="accounts"><h2>Simulation provider accounts</h2><form id="register"><label for="account-name">Account name</label><input id="account-name" required maxlength="120" value="Application account"><p>Credential-free fake role for the simulated connection journey. AWS observations cannot be executed by this planner.</p><button data-write>Register fake account</button></form><ul id="account-list"></ul></section>
<section id="networks"><h2>Regional networks & egress</h2><form id="network-form"><label for="network-name">Network name</label><input id="network-name" required maxlength="120" value="EU regional egress"><button data-write>Create simulated regional network</button></form><ul id="network-list"></ul></section></div>
<section id="connect"><h2>Connect a VPC (simulation only)</h2><form id="plan-form"><div class="grid"><div><label for="vpc">Discovered VPC</label><select id="vpc" required></select><fieldset><legend>Attachment subnets (one per AZ ID)</legend><div id="subnets"></div></fieldset></div><div><label for="network">Regional egress network</label><select id="network" required></select><p>Egress policy: same-region managed NAT, no application-to-application permission. Discovery marks only synthetic demo routes as owned.</p></div></div><button data-write>Generate immutable change plan</button></form></section>
<section id="aws"><h2>AWS read-only accounts & topology</h2><p id="aws-access"></p><form id="aws-register" hidden><label for="aws-name">AWS account name</label><input id="aws-name" required maxlength="120"><label for="aws-role">Target IAM role ARN</label><input id="aws-role" required maxlength="2048" placeholder="arn:aws:iam::123456789012:role/NavarchNetReader"><label for="aws-region">Allowed AWS region</label><select id="aws-region" required></select><label for="aws-external-id">STS ExternalId (optional, never returned in read-only account views)</label><input id="aws-external-id" type="password" maxlength="1224" autocomplete="off"><p>Uses the controller SDK credential chain and a temporary assumed role. Do not enter permanent AWS access keys. Registration verifies the caller; discovery only reads metadata. No cloud mutation is enabled.</p><button data-write data-aws-write>Verify and register AWS role</button></form><ul id="aws-account-list"></ul><div id="aws-topology"></div></section>
<section id="plans"><h2>Review change plans</h2><p>Review prerequisites and postconditions before applying. Applying does not create an atomic cloud transaction.</p><label for="fault">Demo execution scenario</label><select id="fault"><option value="none">Normal</option><option value="throttle">Throttling with retry</option><option value="eventual_consistency">Eventually visible attachment</option><option value="credential_expiry">Expired temporary session</option><option value="permission">Permission denied</option><option value="partial_failure">Partial failure after return routing</option></select><div id="plan-list"></div></section>
<section id="operations"><h2>Durable operation history</h2><p>Refresh to see persisted progress. Closing this browser does not stop execution.</p><div id="operation-list"></div><div id="observation"></div></section>
<section id="diagnostics"><h2>Diagnostics</h2><p>Measurements are untested. A missing future probe heartbeat must not imply an Internet outage. No automatic repair is enabled.</p><button id="audit" type="button">Load audit trail</button><pre id="diagnostic-output"></pre></section></div></main><footer>Apache-2.0 · Development preview · AWS execution disabled · No cloud connectivity verified</footer>`;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
const session = new Session();
let snapshot: Snapshot | undefined;
let selectedAwsAccountId: string | undefined;
let awsViewVersion = 0;
const selectedInventory = () =>
  snapshot?.inventory.find((i) => i.vpc_id === element<HTMLSelectElement>("vpc").value);
const isAdmin = () => snapshot?.role === "admin";
async function request<T>(path: string, body?: unknown): Promise<T> {
  return session.request<T>(path, body);
}
async function run(action: () => Promise<void>) {
  const version = session.version;
  element("notice").textContent = "Working…";
  try {
    await action();
    if (version === session.version)
      element("notice").textContent =
        "Updated. Configuration observations are not connectivity measurements.";
  } catch (error) {
    if (version === session.version)
      element("notice").textContent = error instanceof Error ? error.message : "Request failed";
  }
}
function button(label: string, action: () => Promise<void>, writes = false): HTMLButtonElement {
  const node = text("button", label);
  node.type = "button";
  node.disabled = writes && !isAdmin();
  node.onclick = () => {
    node.disabled = true;
    void run(action).finally(() => {
      node.disabled = writes && !isAdmin();
    });
  };
  return node;
}
function options(id: string, values: { id: string; label: string }[]) {
  const select = element<HTMLSelectElement>(id);
  const previous = select.value;
  select.replaceChildren(
    ...values.map((value) => {
      const option = text("option", value.label);
      option.value = value.id;
      return option;
    }),
  );
  if (values.some((v) => v.id === previous)) select.value = previous;
}
function renderSubnets() {
  const inventory = selectedInventory();
  element("subnets").replaceChildren(
    ...(inventory?.subnets ?? []).map((subnet) => {
      const label = document.createElement("label");
      label.className = "checkbox";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "subnet";
      input.value = subnet.id;
      input.checked = true;
      label.append(
        input,
        document.createTextNode(
          `${subnet.id} · ${subnet.az_id} · ${subnet.default_route_managed ? "owned route" : "adoption required"}`,
        ),
      );
      return label;
    }),
  );
}
function renderPlans(plans: Plan[]) {
  element("plan-list").replaceChildren(
    ...plans.map((plan) => {
      const card = document.createElement("article");
      card.append(
        text("h3", `Plan ${plan.id.slice(0, 8)} · ${plan.actions.length} actions`),
        text(
          "p",
          `Impact: ${plan.request.vpc_id}; ${plan.request.subnet_ids.length} subnets. Immutable digest: ${plan.digest}`,
        ),
      );
      const list = document.createElement("ol");
      for (const action of plan.actions)
        list.append(
          text(
            "li",
            `${action.kind} → ${action.target}. Requires steps: ${action.requires.map((i) => i + 1).join(", ") || "none"}. Verify: ${action.postcondition}`,
          ),
        );
      card.append(
        list,
        button(
          "Apply reviewed plan",
          async () => {
            const body: ApplyPlan = { fault: element<HTMLSelectElement>("fault").value as Fault };
            await request<Operation>(`/plans/${plan.id}/apply`, body);
            await refresh();
          },
          true,
        ),
      );
      return card;
    }),
  );
}
function renderOperations(operations: Operation[]) {
  element("operation-list").replaceChildren(
    ...operations.map((operation) => {
      const card = document.createElement("article");
      const total = snapshot?.plans.find((p) => p.id === operation.plan_id)?.actions.length ?? operation.step;
      card.append(
        text("h3", operationLabel(operation.status, operation.step, total)),
        text("p", `${operation.id} · retries for current step: ${operation.attempts}`),
      );
      if (operation.error) card.append(text("p", operation.error));
      card.append(
        button("Inspect result & step events", async () => {
          const value = await request<Observation>(`/operations/${operation.id}/observation`);
          element("observation").replaceChildren(renderObservation(value));
          element("diagnostic-output").textContent = JSON.stringify(
            await request(`/operations/${operation.id}/events`),
            null,
            2,
          );
        }),
      );
      if (snapshot?.mode === "demo" && ["succeeded", "partial", "failed"].includes(operation.status))
        card.append(
          button(
            "Simulate external drift",
            async () => {
              await request(`/operations/${operation.id}/demo-drift`, {});
              element("observation").replaceChildren(
                renderObservation(await request<Observation>(`/operations/${operation.id}/observation`)),
              );
            },
            true,
          ),
        );
      return card;
    }),
  );
}
async function loadAwsTopology(id: string) {
  selectedAwsAccountId = id;
  const version = ++awsViewVersion;
  element("aws-topology").replaceChildren();
  const view = await request<TopologyView>(`/aws/accounts/${encodeURIComponent(id)}/topology`);
  // Selection changes, like logout, must not let an older response replace the visible account.
  if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
  if (view.topology.account_id !== id) throw new Error("Saved observation account did not match selection");
  element("aws-topology").replaceChildren(
    renderAwsTopology(view, {
      networkAccounts: snapshot?.aws_accounts ?? [],
      isCurrent: () => version === awsViewVersion && selectedAwsAccountId === id,
      onNatReferenceLookup: async (query) => {
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        try {
          const parameters = new URLSearchParams(query);
          const result = await request<NatReferenceResponse>(
            `/aws/accounts/${encodeURIComponent(id)}/nat-reference-lookup?${parameters}`,
          );
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          return result;
        } catch (error) {
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          throw error;
        }
      },
      get canConsent() {
        return isAdmin() && !!snapshot?.aws_read_only_enabled;
      },
      onConsent: async (consent) => {
        await request(`/aws/accounts/${encodeURIComponent(id)}/adoptions`, consent);
        if (selectedAwsAccountId === id) await loadAwsTopology(id);
      },
      onLookup: async (query) => {
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        try {
          const parameters = new URLSearchParams(query);
          const result = await request<TgwLookupResponse>(
            `/aws/accounts/${encodeURIComponent(id)}/tgw-route-lookup?${parameters}`,
          );
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          return result;
        } catch (error) {
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          throw error;
        }
      },
      onSourceLookup: async (query) => {
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        try {
          const parameters = new URLSearchParams(query);
          const result = await request<TgwSourceResponse>(
            `/aws/accounts/${encodeURIComponent(id)}/tgw-source-lookup?${parameters}`,
          );
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          return result;
        } catch (error) {
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          throw error;
        }
      },
      onTargetLookup: async (networkAccountId, query) => {
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        try {
          const parameters = new URLSearchParams(query);
          const result = await request<TgwTargetResponse>(
            `/aws/accounts/${encodeURIComponent(networkAccountId)}/tgw-target-lookup?${parameters}`,
          );
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          return result;
        } catch (error) {
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          throw error;
        }
      },
      onNetworkNatReferenceLookup: async (networkAccountId, query) => {
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        try {
          const parameters = new URLSearchParams(query);
          const result = await request<NatReferenceResponse>(
            `/aws/accounts/${encodeURIComponent(networkAccountId)}/nat-reference-lookup?${parameters}`,
          );
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          return result;
        } catch (error) {
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          throw error;
        }
      },
      onVpcLookup: async (query) => {
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        try {
          const parameters = new URLSearchParams(query);
          const result = await request<VpcLookupResponse>(
            `/aws/accounts/${encodeURIComponent(id)}/vpc-route-lookup?${parameters}`,
          );
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          return result;
        } catch (error) {
          if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
          throw error;
        }
      },
    }),
  );
}
function renderAwsAccounts() {
  const enabled = !!snapshot?.aws_read_only_enabled;
  element("aws-access").textContent = enabled
    ? "Read-only AWS onboarding is explicitly enabled for the listed regions. No AWS network mutation, executable plan or connectivity measurement is available."
    : "AWS SDK access is disabled. Existing saved observations can still be inspected. Enable read-only access only after separate role/account authorization and production OIDC configuration.";
  element("aws-register").hidden = !enabled;
  options(
    "aws-region",
    (snapshot?.aws_regions ?? []).map((region) => ({ id: region, label: region })),
  );
  element("aws-account-list").replaceChildren(
    ...(snapshot?.aws_accounts ?? []).map((account) => {
      const row = document.createElement("li");
      row.append(
        text("strong", account.name),
        text("p", `${account.aws_account_id} · ${account.region} · ${account.role_arn}`),
      );
      row.append(button("View saved AWS observation", async () => loadAwsTopology(account.id)));
      const discover = button(
        "Refresh AWS discovery (read only)",
        async () => {
          if (!snapshot?.aws_read_only_enabled) throw new Error("AWS read-only access is disabled");
          selectedAwsAccountId = account.id;
          ++awsViewVersion;
          element("aws-topology").replaceChildren();
          await request(`/aws/accounts/${encodeURIComponent(account.id)}/discover`, {});
          if (selectedAwsAccountId === account.id) await loadAwsTopology(account.id);
          await refresh();
        },
        true,
      );
      discover.disabled = !enabled || !isAdmin();
      row.append(discover);
      return row;
    }),
  );
}
async function refresh() {
  snapshot = await request<Snapshot>("/snapshot");
  element("workspace").hidden = false;
  element("identity").textContent =
    `${snapshot.mode} authentication · ${snapshot.role} · simulated execution · AWS read-only ${snapshot.aws_read_only_enabled ? "enabled" : "disabled"}`;
  element("summary").textContent =
    `${snapshot.accounts.length} simulated accounts · ${snapshot.aws_accounts.length} AWS read-only account/region registrations · ${snapshot.networks.length} simulated regional networks · ${snapshot.operations.length} recent simulated operations (bounded list)`;
  element("account-list").replaceChildren(
    ...snapshot.accounts.map((account) => {
      const item = document.createElement("li");
      item.append(
        text("strong", account.name),
        text("p", `${account.provider} · ${account.role_arn}`),
        button(
          "Discover VPCs",
          async () => {
            await request<Inventory>(`/accounts/${account.id}/discover`, {});
            await refresh();
          },
          true,
        ),
      );
      return item;
    }),
  );
  element("network-list").replaceChildren(
    ...snapshot.networks.map((network) =>
      text(
        "li",
        `${network.name} · ${network.region} · AZ IDs ${network.az_ids.join(", ")} · simulated public IPs ${network.public_ips.join(", ")}`,
      ),
    ),
  );
  options(
    "vpc",
    snapshot.inventory.map((i) => ({
      id: i.vpc_id,
      label: `${snapshot?.accounts.find((a) => a.id === i.account_id)?.name} · ${i.vpc_id} · ${i.cidr} · ${i.region}`,
    })),
  );
  options(
    "network",
    snapshot.networks.map((n) => ({ id: n.id, label: `${n.name} · ${n.region}` })),
  );
  renderSubnets();
  renderAwsAccounts();
  renderPlans(snapshot.plans);
  renderOperations(snapshot.operations);
  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-write]")) node.disabled = !isAdmin();
  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-aws-write]"))
    node.disabled = !isAdmin() || !snapshot.aws_read_only_enabled;
}
element<HTMLFormElement>("login").onsubmit = (event) => {
  event.preventDefault();
  clearSession();
  session.login(element<HTMLInputElement>("token").value);
  element<HTMLInputElement>("token").value = "";
  void run(refresh);
};
function clearSession() {
  element<HTMLFormElement>("aws-register").reset();
  element("aws-register").hidden = true;
  ++awsViewVersion;
  selectedAwsAccountId = undefined;
  session.logout();
  snapshot = undefined;
  element("workspace").hidden = true;
  element("identity").textContent = "Signed out";
  for (const id of [
    "diagnostic-output",
    "account-list",
    "network-list",
    "plan-list",
    "operation-list",
    "observation",
    "summary",
    "vpc",
    "network",
    "subnets",
    "notice",
    "aws-account-list",
    "aws-topology",
    "aws-access",
    "aws-region",
  ])
    element(id).replaceChildren();
}
element("logout").onclick = clearSession;
element("refresh").onclick = () => void run(refresh);
element<HTMLFormElement>("aws-register").onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    if (!snapshot?.aws_read_only_enabled || !isAdmin())
      throw new Error("AWS role registration is not enabled for this session");
    const body: RoleRegistration = {
      name: element<HTMLInputElement>("aws-name").value,
      role_arn: element<HTMLInputElement>("aws-role").value,
      region: element<HTMLSelectElement>("aws-region").value,
      external_id: element<HTMLInputElement>("aws-external-id").value || null,
    };
    await request<VerifiedAccount>("/aws/accounts", body);
    element<HTMLInputElement>("aws-external-id").value = "";
    await refresh();
  });
};
element<HTMLSelectElement>("vpc").onchange = renderSubnets;
element<HTMLFormElement>("register").onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    const body: RegisterAccount = {
      name: element<HTMLInputElement>("account-name").value,
      provider: "fake",
      role_arn: "fake:demo-role",
    };
    await request<Account>("/accounts", body);
    await refresh();
  });
};
element<HTMLFormElement>("network-form").onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    await request("/networks", { name: element<HTMLInputElement>("network-name").value });
    await refresh();
  });
};
element<HTMLFormElement>("plan-form").onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    const inventory = selectedInventory();
    if (!inventory) throw new Error("Register and discover an account first");
    const body: ConnectionRequest = {
      account_id: inventory.account_id,
      vpc_id: inventory.vpc_id,
      subnet_ids: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="subnet"]:checked')).map(
        (s) => s.value,
      ),
      network_id: element<HTMLSelectElement>("network").value,
      allow_application_traffic: false,
    };
    await request<Plan>("/plans", body);
    await refresh();
    element("plans").scrollIntoView();
  });
};
element("audit").onclick = () =>
  void run(async () => {
    element("diagnostic-output").textContent = JSON.stringify(await request("/audit"), null, 2);
  });

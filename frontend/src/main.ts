import { renderShell } from "./app-shell";
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
  SourceHandoffCidrCoverage,
  TgwLookupResponse,
  TgwSourceResponse,
  TgwTargetResponse,
  TopologyView,
  VerifiedAccount,
  VpcCidrCoverageResponse,
  VpcLookupResponse,
} from "./generated";
import { createNavigation } from "./navigation";
import { renderPlanReview } from "./plan-review-view";
import { Session } from "./session";
import { operationLabel, renderObservation, text } from "./view";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root missing");
renderShell(app);

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
const session = new Session();
let snapshot: Snapshot | undefined;
let selectedAwsAccountId: string | undefined;
let awsViewVersion = 0;
let selectedPlanId: string | undefined;
let planViewVersion = 0;
const navigation = createNavigation(app, () => {
  session.retireRequests();
  ++awsViewVersion;
  selectedAwsAccountId = undefined;
  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-pending]")) {
    node.disabled =
      (node.hasAttribute("data-write") && !isAdmin()) ||
      (node.hasAttribute("data-aws-write") && !snapshot?.aws_read_only_enabled);
    delete node.dataset.pending;
  }
  for (const id of ["aws-topology", "observation", "operation-events", "diagnostic-output", "notice"])
    element(id).replaceChildren();
});
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
function button(
  label: string,
  action: () => Promise<void>,
  writes = false,
  isCurrent = () => true,
): HTMLButtonElement {
  const node = text("button", label);
  node.type = "button";
  if (writes) node.dataset.write = "";
  node.disabled = writes && !isAdmin();
  node.onclick = () => {
    if (!isCurrent()) return;
    const version = session.version;
    node.disabled = true;
    node.dataset.pending = "";
    void run(action).finally(() => {
      if (version === session.version) {
        node.disabled = writes && !isAdmin();
        delete node.dataset.pending;
      }
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
  const version = ++planViewVersion;
  const isCurrent = () =>
    version === planViewVersion && app?.isConnected === true && !!snapshot && !element("plans").hidden;
  element("plan-list").replaceChildren(
    renderPlanReview(plans, {
      selectedPlanId,
      isCurrent,
      onSelect: (id) => {
        if (!isCurrent()) return;
        session.retireRequests();
        element("notice").replaceChildren();
        selectedPlanId = id;
        renderPlans(plans);
        element("plan-selection").focus();
      },
      makeApply: (plan) =>
        button(
          "Apply reviewed plan",
          async () => {
            const body: ApplyPlan = { fault: element<HTMLSelectElement>("fault").value as Fault };
            await request<Operation>(`/plans/${plan.id}/apply`, body);
            await refresh();
            navigation.navigate("operations");
          },
          true,
          isCurrent,
        ),
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
          element("operation-events").textContent = JSON.stringify(
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
  navigation.navigate("aws");
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
      onSourceCidrCoverage: async (query) => {
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        try {
          const parameters = new URLSearchParams(query);
          const result = await request<SourceHandoffCidrCoverage>(
            `/aws/accounts/${encodeURIComponent(id)}/tgw-source-cidr-coverage?${parameters}`,
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
      onVpcCidrCoverage: async (query) => {
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        try {
          const parameters = new URLSearchParams(query);
          const result = await request<VpcCidrCoverageResponse>(
            `/aws/accounts/${encodeURIComponent(id)}/vpc-cidr-coverage?${parameters}`,
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
      discover.dataset.awsWrite = "";
      row.append(discover);
      return row;
    }),
  );
}
async function refresh() {
  snapshot = await request<Snapshot>("/snapshot");
  navigation.authenticate(true);
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
  selectedPlanId = undefined;
  ++planViewVersion;
  connectionStep(false);
  element<HTMLFormElement>("aws-register").reset();
  element("aws-register").hidden = true;
  ++awsViewVersion;
  selectedAwsAccountId = undefined;
  session.logout();
  snapshot = undefined;
  navigation.authenticate(false);
  element("identity").textContent = "Signed out";
  for (const id of [
    "diagnostic-output",
    "account-list",
    "network-list",
    "plan-list",
    "operation-list",
    "observation",
    "operation-events",
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
let configuringConnection = false;
function connectionStep(configure: boolean) {
  if (configure && !selectedInventory()) throw new Error("Register and discover an account first");
  configuringConnection = configure;
  element("connection-select").hidden = configure;
  element("connection-configure").hidden = !configure;
  element("connection-select").inert = configure;
  element("connection-configure").inert = !configure;
  element<HTMLSelectElement>("network").disabled = !configure;
  element("connection-step").textContent = configure
    ? "2. Configure subnets & egress → 3. Review plan"
    : "1. Select VPC → 2. Configure → 3. Review plan";
}
element("configure-connection").onclick = () => void run(async () => connectionStep(true));
element("connection-back").onclick = () => connectionStep(false);
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
    if (!configuringConnection) {
      connectionStep(true);
      return;
    }
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
    const plan = await request<Plan>("/plans", body);
    selectedPlanId = plan.id;
    await refresh();
    navigation.navigate("plans");
  });
};
element("audit").onclick = () =>
  void run(async () => {
    element("diagnostic-output").textContent = JSON.stringify(await request("/audit"), null, 2);
  });

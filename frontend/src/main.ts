import { renderShell } from "./app-shell";
import { renderAwsTopology } from "./aws-view";
import { renderConnectionNetworkContext } from "./connection-network-context";
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
import { plansForWorkspaceScope, renderNetworkWorkspace } from "./network-workspace";
import { renderOperationReview } from "./operation-review-view";
import { recordedOperationForPlan, renderPlanReview } from "./plan-review-view";
import { Session } from "./session";
import { renderObservation, text } from "./view";
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
let selectedOperationId: string | undefined;
let operationViewVersion = 0;
let networkWorkspaceVersion = 0;
let workspaceSelection: { networkId?: string; inventoryKey?: string } = {};
const navigation = createNavigation(app, () => {
  session.retireRequests();
  ++awsViewVersion;
  selectedAwsAccountId = undefined;
  ++networkWorkspaceVersion;
  if (snapshot && window.location.hash === "#/networks") renderNetworkContext();
  else element("network-list").replaceChildren();
  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-pending]")) {
    node.disabled =
      (node.hasAttribute("data-write") && !isAdmin()) ||
      (node.hasAttribute("data-aws-write") && !snapshot?.aws_read_only_enabled);
    delete node.dataset.pending;
  }
  for (const id of ["aws-topology", "observation", "operation-events", "diagnostic-output", "notice"])
    element(id).replaceChildren();
  element("operation-events-details").removeAttribute("open");
});
const selectedInventory = () => {
  const matches = snapshot?.inventory.filter((i) => i.vpc_id === element<HTMLSelectElement>("vpc").value);
  return matches?.length === 1 ? matches[0] : undefined;
};
const isAdmin = () => snapshot?.role === "admin";
async function request<T>(path: string, body?: unknown): Promise<T> {
  return session.request<T>(path, body);
}
async function run(action: () => Promise<void>, isCurrent = () => true) {
  const version = session.version;
  element("notice").textContent = "Working…";
  try {
    await action();
    if (version === session.version && isCurrent())
      element("notice").textContent =
        "Updated. Configuration observations are not connectivity measurements.";
  } catch (error) {
    if (version === session.version && isCurrent())
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
    if (node.disabled || !isCurrent()) return;
    const version = session.version;
    node.disabled = true;
    node.dataset.pending = "";
    void run(action, isCurrent).finally(() => {
      if (version === session.version && isCurrent()) {
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
      input.onchange = () => retireConnectionInput(input);
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
function retireConnectionInput(control: HTMLElement): boolean {
  if (!control.isConnected || !element("plan-form").contains(control) || element("connect").hidden)
    return false;
  session.retireRequests();
  element("notice").replaceChildren();
  return true;
}
function renderNetworkContext() {
  const source = snapshot;
  const version = ++networkWorkspaceVersion;
  if (!source) return;
  const isCurrent = () =>
    version === networkWorkspaceVersion && snapshot === source && !element("networks").hidden;
  element("network-list").replaceChildren(
    renderNetworkWorkspace(source, {
      selection: workspaceSelection,
      isCurrent,
      onSelection: (selection) => {
        workspaceSelection = selection;
      },
      get canConfigure() {
        return isAdmin();
      },
      plans: source.plans,
      onReviewPlan: (plan, inventory, network) => {
        if (
          !isCurrent() ||
          !plansForWorkspaceScope(source, inventory, network)?.includes(plan) ||
          workspaceSelection.networkId !== network.id ||
          workspaceSelection.inventoryKey !== JSON.stringify([inventory.account_id, inventory.vpc_id])
        )
          return;
        session.retireRequests();
        selectedPlanId = plan.id;
        renderPlans(source.plans);
        navigation.navigate("plans");
      },
      onConfigure: (inventory, network, subnet) => {
        if (!isCurrent() || !isAdmin()) return;
        const inventories = source.inventory.filter((i) => i.vpc_id === inventory.vpc_id);
        const networks = source.networks.filter((n) => n.id === network.id);
        const vpc = element<HTMLSelectElement>("vpc");
        const egress = element<HTMLSelectElement>("network");
        const uniqueOption = (select: HTMLSelectElement, value: string) =>
          [...select.options].filter((option) => option.value === value).length === 1;
        if (
          inventories.length !== 1 ||
          inventories[0] !== inventory ||
          networks.length !== 1 ||
          networks[0] !== network ||
          (subnet !== undefined &&
            (!inventory.subnets.includes(subnet) ||
              inventory.subnets.filter((s) => s.id === subnet.id).length !== 1)) ||
          !uniqueOption(vpc, inventory.vpc_id) ||
          !uniqueOption(egress, network.id)
        ) {
          element("notice").textContent =
            "Selected scope cannot be represented uniquely in the connection form. Refresh or select a different scope.";
          return;
        }
        vpc.value = inventory.vpc_id;
        egress.value = network.id;
        renderSubnets();
        if (subnet)
          for (const input of element("subnets").querySelectorAll<HTMLInputElement>('input[name="subnet"]'))
            input.checked = input.value === subnet.id;
        connectionStep(true);
        navigation.navigate("connections");
      },
    }),
  );
}
function renderPlans(plans: Plan[]) {
  const source = snapshot;
  const version = ++planViewVersion;
  const isCurrent = () =>
    version === planViewVersion && app?.isConnected === true && !!snapshot && !element("plans").hidden;
  element("plan-list").replaceChildren(
    renderPlanReview(plans, {
      selectedPlanId,
      isCurrent,
      currentSnapshot: source,
      operations: source?.operations,
      onReviewOperation: (plan, operation) => {
        if (!source || !isCurrent() || snapshot !== source) return;
        const matches = source.plans.filter((record) => record.id === plan.id);
        if (
          matches.length !== 1 ||
          matches[0] !== plan ||
          recordedOperationForPlan(plan, source.operations) !== operation
        )
          return;
        session.retireRequests();
        selectedOperationId = operation.id;
        renderOperations(source.operations);
        navigation.navigate("operations");
      },
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
            const generation = session.version;
            const source = snapshot;
            const body: ApplyPlan = { fault: element<HTMLSelectElement>("fault").value as Fault };
            const operation = await request<Operation>(`/plans/${plan.id}/apply`, body);
            if (generation !== session.version || snapshot !== source || !isCurrent()) return;
            await refresh();
            // The followup retires this draw once; an intervening refresh retires it again.
            if (generation !== session.version || planViewVersion !== version + 1) return;
            selectedOperationId = operation.id;
            renderOperations(snapshot?.operations ?? []);
            navigation.navigate("operations");
          },
          true,
          isCurrent,
        ),
    }),
  );
}
function clearOperationEvidence() {
  element("observation").replaceChildren();
  element("operation-events").replaceChildren();
  element("operation-events-details").removeAttribute("open");
}
function renderOperations(operations: Operation[]) {
  const source = snapshot;
  const version = ++operationViewVersion;
  if (selectedOperationId === undefined) selectedOperationId = operations[0]?.id;
  clearOperationEvidence();
  const isCurrent = () =>
    version === operationViewVersion &&
    app?.isConnected === true &&
    !!snapshot &&
    !element("operations").hidden;
  function action(label: string, execute: (current: () => boolean) => Promise<void>, writes = false) {
    return button(
      label,
      async () => {
        const generation = session.version;
        const current = () => isCurrent() && generation === session.version;
        // One active detail action per view; navigation retires, not cancels remote work.
        for (const control of document.querySelectorAll<HTMLButtonElement>(
          "#operation-list [data-operation-action]",
        )) {
          control.disabled = true;
          control.dataset.pending = "";
        }
        clearOperationEvidence();
        try {
          await execute(current);
        } finally {
          if (current())
            for (const control of document.querySelectorAll<HTMLButtonElement>(
              "#operation-list [data-operation-action]",
            )) {
              control.disabled = control.hasAttribute("data-write") && !isAdmin();
              delete control.dataset.pending;
            }
        }
      },
      writes,
      isCurrent,
    );
  }
  element("operation-list").replaceChildren(
    renderOperationReview(operations, snapshot?.plans ?? [], {
      selectedOperationId,
      isCurrent,
      onReviewPlan: (plan) => {
        if (!source || !isCurrent() || snapshot !== source) return;
        const matches = source.plans.filter((p) => p.id === plan.id);
        if (matches.length !== 1 || matches[0] !== plan) return;
        session.retireRequests();
        selectedPlanId = plan.id;
        renderPlans(source.plans);
        navigation.navigate("plans");
      },
      onSelect: (id) => {
        if (!isCurrent()) return;
        session.retireRequests();
        element("notice").replaceChildren();
        selectedOperationId = id;
        renderOperations(operations);
        element("operation-selection").focus();
      },
      makeInspect: (operation) =>
        action("Inspect result & step events", async (current) => {
          const value = await request<Observation>(`/operations/${operation.id}/observation`);
          if (!current()) return;
          if (value.operation_id !== operation.id)
            throw new Error("Observation did not match selected operation");
          const events = await request(`/operations/${operation.id}/events`);
          if (!current()) return;
          element("observation").replaceChildren(renderObservation(value));
          element("operation-events").textContent = JSON.stringify(events, null, 2);
        }),
      makeDrift:
        snapshot?.mode === "demo"
          ? (operation) =>
              action(
                "Simulate external drift",
                async (current) => {
                  await request(`/operations/${operation.id}/demo-drift`, {});
                  if (!current()) return;
                  const value = await request<Observation>(`/operations/${operation.id}/observation`);
                  if (!current()) return;
                  if (value.operation_id !== operation.id)
                    throw new Error("Observation did not match selected operation");
                  element("observation").replaceChildren(renderObservation(value));
                },
                true,
              )
          : undefined,
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
        if (version !== awsViewVersion || selectedAwsAccountId !== id) return;
        await request(`/aws/accounts/${encodeURIComponent(id)}/adoptions`, consent);
        if (version === awsViewVersion && selectedAwsAccountId === id) await loadAwsTopology(id);
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
  renderNetworkContext();
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
  renderSelectedNetworkContext();
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
  ++networkWorkspaceVersion;
  workspaceSelection = {};
  selectedOperationId = undefined;
  ++operationViewVersion;
  clearOperationEvidence();
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
const vpcChoice = element<HTMLSelectElement>("vpc");
vpcChoice.onchange = () => {
  if (retireConnectionInput(vpcChoice)) renderSubnets();
};
const networkChoice = element<HTMLSelectElement>("network");
const networkContext = document.createElement("div");
networkContext.id = "connection-network-context";
networkContext.setAttribute("aria-live", "polite");
networkChoice.after(networkContext);
networkChoice.onchange = () => {
  if (retireConnectionInput(networkChoice)) renderSelectedNetworkContext();
};
let configuringConnection = false;
function renderSelectedNetworkContext() {
  networkContext.replaceChildren();
  if (snapshot && configuringConnection)
    networkContext.append(
      renderConnectionNetworkContext(snapshot.networks, element<HTMLSelectElement>("network").value),
    );
}
function connectionStep(configure: boolean) {
  const inventory = configure ? selectedInventory() : undefined;
  if (configure && !inventory)
    throw new Error("Selected VPC is unavailable or ambiguous. Refresh discovery or choose a unique VPC.");
  configuringConnection = configure;
  element("connection-select").hidden = configure;
  element("connection-configure").hidden = !configure;
  element("connection-select").inert = configure;
  element("connection-configure").inert = !configure;
  element<HTMLSelectElement>("network").disabled = !configure;
  element("connection-step").textContent = configure
    ? `2. Configure ${inventory?.vpc_id} subnets & egress → 3. Review plan`
    : "1. Select VPC → 2. Configure → 3. Review plan";
  renderSelectedNetworkContext();
}
element("configure-connection").onclick = () => void run(async () => connectionStep(true));
const connectionBack = element("connection-back");
connectionBack.onclick = () => {
  if (retireConnectionInput(connectionBack)) connectionStep(false);
};
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
  const source = snapshot;
  const version = session.version;
  void run(
    async () => {
      if (!configuringConnection) {
        connectionStep(true);
        return;
      }
      const inventory = selectedInventory();
      if (!inventory)
        throw new Error(
          "Selected VPC is unavailable or ambiguous. Refresh discovery or choose a unique VPC.",
        );
      const body: ConnectionRequest = {
        account_id: inventory.account_id,
        vpc_id: inventory.vpc_id,
        subnet_ids: Array.from(
          document.querySelectorAll<HTMLInputElement>('input[name="subnet"]:checked'),
        ).map((s) => s.value),
        network_id: element<HTMLSelectElement>("network").value,
        allow_application_traffic: false,
      };
      const plan = await request<Plan>("/plans", body);
      if (version !== session.version || snapshot !== source) return;
      const viewVersion = planViewVersion;
      await refresh();
      if (version !== session.version || planViewVersion !== viewVersion + 1) return;
      selectedPlanId = plan.id;
      renderPlans(snapshot?.plans ?? []);
      navigation.navigate("plans");
    },
    () => version === session.version && snapshot === source,
  );
};
element("audit").onclick = () =>
  void run(async () => {
    element("diagnostic-output").textContent = JSON.stringify(await request("/audit"), null, 2);
  });

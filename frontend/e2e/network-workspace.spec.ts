/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Account, Inventory, RegionalNetwork, Snapshot } from "../src/generated";

test("real API simulation inventory has a scoped network map and read-only inspector", async ({
  page,
  request,
}, testInfo) => {
  const headers = { authorization: "Bearer browser-test-admin-credential-free-local-only" };
  const suffix = Date.now();
  const registered = await request.post("/api/v1/accounts", {
    headers,
    data: { name: `Workspace app ${suffix}`, provider: "fake", role_arn: "fake:demo-role" },
  });
  expect(registered.ok()).toBe(true);
  const account = (await registered.json()) as Account;
  const discovered = await request.post(`/api/v1/accounts/${account.id}/discover`, { headers, data: {} });
  expect(discovered.ok()).toBe(true);
  const inventory = (await discovered.json()) as Inventory;
  const created = await request.post("/api/v1/networks", {
    headers,
    data: { name: `Workspace egress ${suffix}` },
  });
  expect(created.ok()).toBe(true);
  const network = (await created.json()) as RegionalNetwork;
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await page.goto("/#/networks");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/snapshot");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const snapshot = (await (await refreshed).json()) as Snapshot;
  expect(snapshot.networks).toContainEqual(network);
  expect(snapshot.inventory).toContainEqual(inventory);
  expect(snapshot.accounts).toContainEqual(account);
  // Seed and actual authenticated snapshot are established before the missing-UI assertion.
  await expect(page.getByRole("heading", { name: "Network workspace", exact: true })).toBeVisible();
  await page.getByLabel("Regional network in workspace", { exact: true }).selectOption(network.id);
  await page
    .getByLabel("VPC in workspace", { exact: true })
    .selectOption(JSON.stringify([account.id, inventory.vpc_id]));
  const map = page.getByRole("region", { name: "Simulation network map", exact: true });
  await expect(map).toContainText(inventory.cidr);
  await expect(map).toContainText(network.egress_cidr);
  await expect(map).toContainText("Same region does not establish a connection");
  await page
    .getByRole("button", { name: `Inspect application VPC ${inventory.vpc_id}`, exact: true })
    .click();
  const inspector = page.getByRole("complementary", { name: "Network resource inspector" });
  await expect(inspector).toContainText(account.name);
  await inspector.getByText("Original returned data", { exact: true }).click();
  expect(JSON.parse((await inspector.locator("pre").textContent()) ?? "null")).toEqual(inventory);
  await page.getByRole("button", { name: `Inspect regional network ${network.name}`, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(inspector).toContainText(network.name);
  await expect(inspector).toContainText("Used egress and connectivity are unknown");
  await page.getByText("Create regional network", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create simulated regional network", exact: true }),
  ).toBeDisabled();
  await page.getByText("Create regional network", { exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath("network-workspace-running-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Accounts & discovery", exact: true })
    .click();
  await expect(page.locator("#networks")).toBeHidden();
  await page.goBack();
  await expect(page.locator("#networks")).toBeVisible();
  await page
    .getByRole("button", { name: `Inspect application VPC ${inventory.vpc_id}`, exact: true })
    .click();
  await expect(inspector).toContainText(account.name);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("network-workspace-running-mobile.png"),
    fullPage: true,
  });
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#network-list")).toBeEmpty();

  // Original reader map/navigation/logout oracles above remain unchanged.
  // A second real scope makes an accidental old/default form selection observable.
  const secondResponse = await request.post("/api/v1/accounts", {
    headers,
    data: { name: `Other workspace ${suffix}`, provider: "fake", role_arn: "fake:demo-role" },
  });
  expect(secondResponse.ok()).toBe(true);
  const second = (await secondResponse.json()) as Account;
  const secondDiscovery = await request.post(`/api/v1/accounts/${second.id}/discover`, { headers, data: {} });
  expect(secondDiscovery.ok()).toBe(true);
  const secondInventory = (await secondDiscovery.json()) as Inventory;
  const secondNetworkResponse = await request.post("/api/v1/networks", {
    headers,
    data: { name: `Other egress ${suffix}` },
  });
  expect(secondNetworkResponse.ok()).toBe(true);
  const secondNetwork = (await secondNetworkResponse.json()) as RegionalNetwork;
  await page.goto("/#/connections");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-admin-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("Discovered VPC", { exact: true }).selectOption(secondInventory.vpc_id);
  await page.getByRole("button", { name: "Configure connection", exact: true }).click();
  await page.getByLabel("Regional egress network", { exact: true }).selectOption(secondNetwork.id);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Regional networks", exact: true })
    .click();
  await page.getByLabel("Regional network in workspace", { exact: true }).selectOption(network.id);
  await page
    .getByLabel("VPC in workspace", { exact: true })
    .selectOption(JSON.stringify([account.id, inventory.vpc_id]));
  const localCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/")) localCalls.push(r.url());
  });
  // Both actual scopes established before the missing selected-scope action RED.
  const configure = page.getByRole("button", { name: "Configure selected VPC", exact: true });
  await expect(configure).toBeVisible();
  await configure.click();
  await expect(page.locator("#connection-configure")).toBeVisible();
  await expect(page.getByLabel("Discovered VPC", { exact: true })).toHaveValue(inventory.vpc_id);
  await expect(page.getByLabel("Regional egress network", { exact: true })).toHaveValue(network.id);
  expect(
    await page
      .locator("#subnets input:checked")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLInputElement).value)),
  ).toEqual(inventory.subnets.map((s) => s.id));
  expect(localCalls).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#connect").screenshot({ path: testInfo.outputPath("map-plan-handoff-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#connect").screenshot({ path: testInfo.outputPath("map-plan-handoff-mobile.png") });
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  await page.getByRole("button", { name: "Generate immutable change plan", exact: true }).click();
  const planned = await saved;
  expect(planned.status()).toBe(200);
  const body = await planned.json();
  expect(body.request).toEqual({
    account_id: account.id,
    vpc_id: inventory.vpc_id,
    subnet_ids: inventory.subnets.map((s) => s.id).sort(),
    network_id: network.id,
    allow_application_traffic: false,
  });
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", body.id);

  // All original whole-VPC handoff assertions above remain unchanged.
  // The existing real inventory's second subnet differs from all-subnet defaults.
  expect(inventory.subnets.length).toBeGreaterThan(1);
  const selectedSubnet = inventory.subnets[inventory.subnets.length - 1];
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Regional networks", exact: true })
    .click();
  await page.getByLabel("Regional network in workspace", { exact: true }).selectOption(network.id);
  await page
    .getByLabel("VPC in workspace", { exact: true })
    .selectOption(JSON.stringify([account.id, inventory.vpc_id]));
  await page.getByRole("button", { name: `Inspect subnet ${selectedSubnet.id}`, exact: true }).click();
  await inspector.getByText("Original returned data", { exact: true }).click();
  expect(JSON.parse((await inspector.locator("pre").textContent()) ?? "null")).toEqual(selectedSubnet);
  const selectedAction = page.getByRole("button", { name: "Configure selected subnet", exact: true });
  await expect(selectedAction).toBeVisible();
  await expect(
    inspector
      .locator("dt")
      .filter({ hasText: /^Subnet ID$/ })
      .locator("+ dd"),
  ).toHaveText(selectedSubnet.id);
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`map-subnet-handoff-${label}.png`), fullPage: true });
  }
  const beforeCalls = localCalls.length;
  await selectedAction.click();
  await expect(page.locator("#connection-configure")).toBeVisible();
  expect(
    await page
      .locator("#subnets input:checked")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLInputElement).value)),
  ).toEqual([selectedSubnet.id]);
  await expect(page.locator("#subnets input")).toHaveCount(inventory.subnets.length);
  await expect(page.getByLabel("Discovered VPC", { exact: true })).toHaveValue(inventory.vpc_id);
  await expect(page.getByLabel("Regional egress network", { exact: true })).toHaveValue(network.id);
  expect(localCalls).toHaveLength(beforeCalls);
  const subsetSaved = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  await page.getByRole("button", { name: "Generate immutable change plan", exact: true }).click();
  const subsetResponse = await subsetSaved;
  expect(subsetResponse.status()).toBe(200);
  const subsetPlan = await subsetResponse.json();
  expect(subsetPlan.request).toEqual({
    account_id: account.id,
    vpc_id: inventory.vpc_id,
    subnet_ids: [selectedSubnet.id],
    network_id: network.id,
    allow_application_traffic: false,
  });
  expect(subsetPlan.id).not.toBe(body.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", subsetPlan.id);

  // All original map/VPC/subnet/immutable-request assertions above remain unchanged.
  // Read-only review of an older actual plan must export that exact record, not the newest default.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/#/plans");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("Plan to review", { exact: true }).selectOption(body.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", body.id);
  await expect(page.getByRole("button", { name: "Apply reviewed plan", exact: true })).toBeDisabled();
  const beforeExport = await (await request.get("/api/v1/snapshot", { headers })).json();
  expect(beforeExport.plans).toContainEqual(body);
  const exportCalls = localCalls.length;
  const exportPlan = page.getByRole("button", { name: "Download original plan JSON", exact: true });
  await expect(exportPlan).toBeVisible();
  await expect(exportPlan).toBeEnabled();
  const downloadEvent = page.waitForEvent("download");
  await exportPlan.focus();
  await page.keyboard.press("Enter");
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("navarchnet-plan.json");
  const downloadedPath = testInfo.outputPath("original-immutable-plan.json");
  await download.saveAs(downloadedPath);
  expect(JSON.parse(await readFile(downloadedPath, "utf8"))).toEqual(body);
  await page.getByLabel("Plan to review", { exact: true }).selectOption(subsetPlan.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", subsetPlan.id);
  const secondDownloadEvent = page.waitForEvent("download");
  await exportPlan.focus();
  await page.keyboard.press("Enter");
  const secondDownload = await secondDownloadEvent;
  expect(secondDownload.suggestedFilename()).toBe("navarchnet-plan.json");
  const secondPath = testInfo.outputPath("original-immutable-subset-plan.json");
  await secondDownload.saveAs(secondPath);
  expect(JSON.parse(await readFile(secondPath, "utf8"))).toEqual(subsetPlan);
  await page.getByLabel("Plan to review", { exact: true }).selectOption(body.id);
  expect(localCalls).toHaveLength(exportCalls);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(beforeExport);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", body.id);
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const applyBox = await page
      .getByRole("button", { name: "Apply reviewed plan", exact: true })
      .boundingBox();
    const downloadBox = await exportPlan.boundingBox();
    if (!applyBox || !downloadBox) throw new Error("Plan actions are not visible");
    expect(
      downloadBox.x >= applyBox.x + applyBox.width + 4 || downloadBox.y >= applyBox.y + applyBox.height + 4,
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`plan-json-export-${label}.png`), fullPage: true });
  }

  // All original map/configuration/plan/export assertions above remain unchanged.
  // Configure against a different actual network without another form or query.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/#/connections");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-admin-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("Discovered VPC", { exact: true }).selectOption(inventory.vpc_id);
  await page.getByRole("button", { name: "Configure connection", exact: true }).click();
  const contextBefore = await (await request.get("/api/v1/snapshot", { headers })).json();
  expect(contextBefore.networks).toContainEqual(secondNetwork);
  const contextCalls = localCalls.length;
  await page.getByLabel("Regional egress network", { exact: true }).selectOption(secondNetwork.id);
  const networkContext = page.getByRole("region", { name: "Selected regional network", exact: true });
  await expect(networkContext).toBeVisible();
  await expect(networkContext).toHaveAttribute("data-network-id", secondNetwork.id);
  await expect(networkContext).toContainText(secondNetwork.name);
  await expect(networkContext).toContainText(secondNetwork.region);
  await expect(networkContext).toContainText(secondNetwork.egress_cidr);
  await expect(networkContext).toContainText(`Snapshot revision ${secondNetwork.revision}`);
  await expect(networkContext).toContainText("not measured egress");
  await page.getByLabel("Regional egress network", { exact: true }).selectOption(network.id);
  await expect(networkContext).toHaveAttribute("data-network-id", network.id);
  await expect(networkContext).toContainText(network.name);
  await page.getByLabel("Regional egress network", { exact: true }).selectOption(secondNetwork.id);
  await expect(networkContext).toHaveAttribute("data-network-id", secondNetwork.id);
  expect(localCalls).toHaveLength(contextCalls);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(contextBefore);
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#connect")
      .screenshot({ path: testInfo.outputPath(`connection-network-context-${label}.png`) });
  }
  const contextualSaved = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  await page.getByRole("button", { name: "Generate immutable change plan", exact: true }).click();
  const contextualResponse = await contextualSaved;
  expect(contextualResponse.ok()).toBe(true);
  const contextualPlan = await contextualResponse.json();
  expect(contextualPlan.request).toEqual({
    account_id: account.id,
    vpc_id: inventory.vpc_id,
    subnet_ids: inventory.subnets.map((s) => s.id).sort(),
    network_id: secondNetwork.id,
    allow_application_traffic: false,
  });
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", contextualPlan.id);

  // Preserve every prior map/configuration/export/context oracle above.
  // Read existing plans for this explicit map scope rather than generating another.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/#/plans");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#plan-selection")).toBeVisible();
  await page.locator("#plan-selection").selectOption(contextualPlan.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", contextualPlan.id);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Regional networks", exact: true })
    .click();
  await page.getByLabel("Regional network in workspace", { exact: true }).selectOption(network.id);
  await page
    .getByLabel("VPC in workspace", { exact: true })
    .selectOption(JSON.stringify([account.id, inventory.vpc_id]));
  await page
    .getByRole("button", { name: `Inspect application VPC ${inventory.vpc_id}`, exact: true })
    .click();
  const historyBefore = await (await request.get("/api/v1/snapshot", { headers })).json();
  const matchingPlans = historyBefore.plans.filter(
    (p: typeof body) =>
      p.request.account_id === account.id &&
      p.request.vpc_id === inventory.vpc_id &&
      p.request.network_id === network.id,
  );
  expect(matchingPlans.map((p: typeof body) => p.id).sort()).toEqual([body.id, subsetPlan.id].sort());
  expect(historyBefore.plans).toContainEqual(contextualPlan);
  const historyCalls = localCalls.length;
  const savedPlans = page.getByLabel("Saved plans for selected VPC", { exact: true });
  await expect(savedPlans).toBeVisible();
  expect(
    await savedPlans
      .locator("option")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value)),
  ).toEqual(["", ...matchingPlans.map((p: typeof body) => p.id)]);
  const reviewSaved = page.getByRole("button", { name: "Review selected saved plan", exact: true });
  await expect(reviewSaved).toBeDisabled();
  await savedPlans.selectOption(body.id);
  await expect(reviewSaved).toBeEnabled();
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#network-list")
      .screenshot({ path: testInfo.outputPath(`workspace-saved-plan-${label}.png`) });
  }
  await reviewSaved.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/plans$/);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", body.id);
  await expect(page.locator("#plan-list")).toContainText(body.digest);
  await expect(page.locator("#plan-list button[data-write]")).toBeDisabled();
  const originalPlan = page
    .locator("#plan-list article details")
    .filter({ has: page.locator("summary", { hasText: "Technical plan identifiers & original evidence" }) });
  await originalPlan.locator("summary").click();
  expect(JSON.parse(await originalPlan.locator("pre").innerText())).toEqual(body);
  expect(localCalls).toHaveLength(historyCalls);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(historyBefore);

  // All previous map/configuration/export/history assertions are preserved above.
  // Explicit real rediscovery changes current metadata, not the immutable old plan.
  const rediscovery = await request.post(`/api/v1/accounts/${account.id}/discover`, { headers, data: {} });
  expect(rediscovery.ok()).toBe(true);
  const rediscovered = (await rediscovery.json()) as Inventory;
  expect(rediscovered.account_id).toBe(account.id);
  expect(rediscovered.vpc_id).toBe(inventory.vpc_id);
  expect(rediscovered.revision).toBeGreaterThan(body.inventory_revision);
  const revisionSnapshot = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/snapshot");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const revisionResponse = await revisionSnapshot;
  const returnedRevision = await revisionResponse.json();
  expect(returnedRevision.inventory).toContainEqual(rediscovered);
  expect(returnedRevision.plans).toContainEqual(body);
  await expect(page.locator("#notice")).toHaveText(
    "Updated. Configuration observations are not connectivity measurements.",
  );
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", body.id);
  const revisionCalls = localCalls.length;
  const revisionContext = page.getByRole("region", { name: "Plan revision comparison", exact: true });
  await expect(revisionContext).toBeVisible();
  await expect(revisionContext).toHaveAttribute("data-revision-comparison", "different");
  await expect(revisionContext).toContainText(
    `Plan ${body.inventory_revision} · returned snapshot ${rediscovered.revision}`,
  );
  await expect(revisionContext).toContainText(
    `Plan ${body.network_revision} · returned snapshot ${network.revision}`,
  );
  await expect(revisionContext).toContainText("server still validates apply");
  await expect(revisionContext).toContainText("Current scope version is not returned");
  await expect(page.locator("#plan-list button[data-write]")).toBeDisabled();
  await originalPlan.locator("summary").click();
  expect(JSON.parse(await originalPlan.locator("pre").innerText())).toEqual(body);
  await originalPlan.locator("summary").click();
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#plan-list")
      .screenshot({ path: testInfo.outputPath(`plan-revision-comparison-${label}.png`) });
  }
  expect(localCalls).toHaveLength(revisionCalls);
  expect((await (await request.get("/api/v1/snapshot", { headers })).json()).plans).toContainEqual(body);

  // All previous map and plan-revision assertions remain unchanged.
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Regional networks", exact: true })
    .click();
  await expect(page.locator("#networks")).toBeVisible();
  await page.getByLabel("Regional network in workspace", { exact: true }).selectOption(secondNetwork.id);
  await page
    .getByLabel("VPC in workspace", { exact: true })
    .selectOption(JSON.stringify([second.id, secondInventory.vpc_id]));
  await page.goBack();
  await expect(page.locator("#plans")).toBeVisible();
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", body.id);
  const mapBefore = await (await request.get("/api/v1/snapshot", { headers })).json();
  expect(mapBefore.plans).toContainEqual(body);
  const mapCalls = localCalls.length;
  const locateScope = page.getByRole("button", { name: "Locate requested scope on map", exact: true });
  await expect(locateScope).toBeVisible();
  await expect(locateScope).toBeEnabled();
  await locateScope.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#networks")).toBeVisible();
  await expect(page.getByLabel("Regional network in workspace", { exact: true })).toHaveValue(
    body.request.network_id,
  );
  await expect(page.getByLabel("VPC in workspace", { exact: true })).toHaveValue(
    JSON.stringify([body.request.account_id, body.request.vpc_id]),
  );
  const mapInspector = page.getByRole("complementary", { name: "Network resource inspector", exact: true });
  await expect(mapInspector).toContainText("Application VPC");
  await mapInspector.getByText("Original returned data", { exact: true }).click();
  await expect(mapInspector.locator("pre")).toBeVisible();
  expect(JSON.parse(await mapInspector.locator("pre").innerText())).toEqual(rediscovered);
  await mapInspector.getByText("Original returned data", { exact: true }).click();
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#network-list")
      .screenshot({ path: testInfo.outputPath(`plan-map-handoff-${label}.png`) });
  }
  expect(localCalls).toHaveLength(mapCalls);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(mapBefore);

  // All previous map-location and nonmutation assertions remain unchanged.
  await page.locator("#logout").click();
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-admin-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Connections / plans", exact: true })
    .click();
  await expect(page.locator("#connect")).toBeVisible();
  await page.getByLabel("Discovered VPC", { exact: true }).selectOption(secondInventory.vpc_id);
  await page.getByRole("button", { name: "Configure connection", exact: true }).click();
  await page.getByLabel("Regional egress network", { exact: true }).selectOption(secondNetwork.id);
  await page.getByRole("link", { name: "Review existing change plans", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.locator("#plan-selection").selectOption(subsetPlan.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", subsetPlan.id);
  const configureBefore = await (await request.get("/api/v1/snapshot", { headers })).json();
  expect(configureBefore.plans).toContainEqual(subsetPlan);
  const configureCalls = localCalls.length;
  const configureOriginal = page.getByRole("button", {
    name: "Configure another plan from original request",
    exact: true,
  });
  await expect(configureOriginal).toBeVisible();
  await expect(configureOriginal).toBeEnabled();
  await configureOriginal.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#connection-configure")).toBeVisible();
  await expect(page.getByLabel("Discovered VPC", { exact: true })).toHaveValue(subsetPlan.request.vpc_id);
  await expect(page.getByLabel("Regional egress network", { exact: true })).toHaveValue(
    subsetPlan.request.network_id,
  );
  expect(
    await page
      .locator("#subnets input:checked")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLInputElement).value)),
  ).toEqual(subsetPlan.request.subnet_ids);
  expect(localCalls).toHaveLength(configureCalls);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(configureBefore);
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("#connect").screenshot({ path: testInfo.outputPath(`plan-reconfigure-${label}.png`) });
  }
  const newPlanResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  await page.getByRole("button", { name: "Generate immutable change plan", exact: true }).click();
  const newPlanResult = await newPlanResponse;
  expect(newPlanResult.status()).toBe(200);
  const freshPlan = await newPlanResult.json();
  expect(freshPlan.id).not.toBe(subsetPlan.id);
  expect(freshPlan.request).toEqual(subsetPlan.request);
  expect(freshPlan.inventory_revision).toBe(rediscovered.revision);
  const afterConfigure = await (await request.get("/api/v1/snapshot", { headers })).json();
  expect(afterConfigure.plans).toContainEqual(subsetPlan);
  expect(afterConfigure.plans).toContainEqual(freshPlan);
  expect(afterConfigure.operations).toEqual(configureBefore.operations);

  // All previous original-request preparation and immutable-generation assertions remain unchanged.
  const requestedReaderHeaders = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  await page.locator("#logout").click();
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Connections / plans", exact: true })
    .click();
  await expect(page.locator("#connect")).toBeVisible();
  await page.getByRole("link", { name: "Review existing change plans", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.locator("#plan-selection").selectOption(subsetPlan.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", subsetPlan.id);
  const subsetBefore = await (
    await request.get("/api/v1/snapshot", { headers: requestedReaderHeaders })
  ).json();
  expect(subsetBefore.plans).toContainEqual(subsetPlan);
  expect(subsetBefore.role).toBe("read_only");
  expect(subsetBefore).toEqual({ ...afterConfigure, role: "read_only" });
  const subsetCalls = localCalls.length;
  await page.getByRole("button", { name: "Locate requested scope on map", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#networks")).toBeVisible();
  await expect(page.getByLabel("Regional network in workspace", { exact: true })).toHaveValue(
    subsetPlan.request.network_id,
  );
  await expect(page.getByLabel("VPC in workspace", { exact: true })).toHaveValue(
    JSON.stringify([subsetPlan.request.account_id, subsetPlan.request.vpc_id]),
  );
  const requestedSubset = page.getByRole("region", { name: "Original plan requested subnets", exact: true });
  await expect(requestedSubset).toBeVisible();
  await expect(requestedSubset).toHaveAttribute("data-plan-id", subsetPlan.id);
  await expect(requestedSubset).toHaveAttribute("data-plan-digest", subsetPlan.digest);
  expect(await requestedSubset.locator("[data-requested-subnet]").allTextContents()).toEqual(
    subsetPlan.request.subnet_ids,
  );
  expect(
    await page
      .locator("#network-list [data-plan-requested-subnet]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-plan-requested-subnet"))),
  ).toEqual(subsetPlan.request.subnet_ids);
  await expect(requestedSubset).toContainText("not historical membership or an applied connection");
  await expect(page.getByRole("button", { name: "Configure selected VPC", exact: true })).toBeDisabled();
  expect(localCalls).toHaveLength(subsetCalls);
  expect(await (await request.get("/api/v1/snapshot", { headers: requestedReaderHeaders })).json()).toEqual(
    subsetBefore,
  );
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#network-list")
      .screenshot({ path: testInfo.outputPath(`plan-map-requested-subnets-${label}.png`) });
  }

  // All previous original-request/map/reader/nonmutation assertions remain unchanged.
  await page.locator("#logout").click();
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-admin-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Connections / plans", exact: true })
    .click();
  await expect(page.locator("#connect")).toBeVisible();
  await page.getByRole("link", { name: "Review existing change plans", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.locator("#plan-selection").selectOption(subsetPlan.id);
  const admissionBefore = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
  const beforePrepareCalls = localCalls.length;
  await page
    .getByRole("button", { name: "Configure another plan from original request", exact: true })
    .click();
  await expect(page.locator("#connection-configure")).toBeVisible();
  expect(localCalls).toHaveLength(beforePrepareCalls);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(admissionBefore);
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let admitted = 0;
  await page.route("**/api/v1/plans", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    admitted++;
    await gate;
    await route.continue();
  });
  const generatedResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  const generate = page.getByRole("button", { name: "Generate immutable change plan", exact: true });
  const writesBeforeAdmission = writes.length;
  try {
    await generate.click();
    await expect.poll(() => admitted).toBe(1);
    await expect(generate).toBeDisabled();
    await page.locator("#plan-form").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    for (const [width, height, label] of [
      [1440, 1000, "desktop"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page
        .locator("#connect")
        .screenshot({ path: testInfo.outputPath(`plan-generation-pending-${label}.png`) });
    }
    await page
      .locator("#connection-configure")
      .screenshot({ path: testInfo.outputPath("plan-generation-pending-control.png") });
    expect(admitted).toBe(1);
    expect(writes).toHaveLength(writesBeforeAdmission + 1);
    expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(admissionBefore);
  } finally {
    release();
  }
  const generatedResult = await generatedResponse;
  expect(generatedResult.status()).toBe(200);
  const admittedPlan = await generatedResult.json();
  expect(admittedPlan.id).not.toBe(subsetPlan.id);
  expect(admittedPlan.request).toEqual(subsetPlan.request);
  await expect(page.locator("#plans")).toBeVisible();
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", admittedPlan.id);
  await page.getByText("Technical plan identifiers & original evidence", { exact: true }).click();
  expect(JSON.parse(await page.locator("#plan-list article details pre").innerText())).toEqual(admittedPlan);
  const admissionAfter = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
  expect(admissionAfter.plans).toHaveLength(admissionBefore.plans.length + 1);
  expect(admissionAfter.plans).toContainEqual(subsetPlan);
  expect(admissionAfter.plans).toContainEqual(admittedPlan);
  expect(admissionAfter.operations).toEqual(admissionBefore.operations);
  expect(admitted).toBe(1);
  expect(writes).toHaveLength(writesBeforeAdmission + 1);
  await page.unroute("**/api/v1/plans");
  await page.locator("#fault").selectOption("none");
  const appliedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/v1/plans/${admittedPlan.id}/apply`,
  );
  await page.getByRole("button", { name: "Apply reviewed plan", exact: true }).click();
  const appliedResult = await appliedResponse;
  expect(appliedResult.status()).toBe(200);
  const admittedOperation = await appliedResult.json();
  expect(admittedOperation.plan_id).toBe(admittedPlan.id);
  await expect(page.locator("#operations")).toBeVisible();
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    admittedOperation.id,
  );
  const operationAfter = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
  expect(operationAfter.plans.find((p) => p.id === admittedPlan.id)).toEqual(admittedPlan);
  expect(operationAfter.plans.find((p) => p.id === subsetPlan.id)).toEqual(subsetPlan);
  expect(operationAfter.operations.find((o) => o.id === admittedOperation.id)?.plan_id).toBe(admittedPlan.id);
  expect(writes).toHaveLength(writesBeforeAdmission + 2);

  // Keep all prior oracles; only the acknowledged write's following browser read fails.
  // Test-harness API reads wait for existing simulation work, not application polling.
  await expect
    .poll(async () => {
      const saved = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
      return saved.operations.find((o) => o.id === admittedOperation.id)?.status;
    })
    .toBe("succeeded");
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Connections / plans", exact: true })
    .click();
  await expect(page.locator("#connect")).toBeVisible();
  await page.getByRole("link", { name: "Review existing change plans", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.locator("#plan-selection").selectOption(admittedPlan.id);
  await page
    .getByRole("button", { name: "Configure another plan from original request", exact: true })
    .click();
  await expect(page.locator("#connection-configure")).toBeVisible();
  const ackRecoveryBefore = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
  const ackRecoveryWrites = writes.length;
  await page.route("**/api/v1/snapshot", (route) => route.abort("failed"), { times: 1 });
  const ackRecoveryPost = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  const ackRecoveryReadFailure = page.waitForEvent(
    "requestfailed",
    (r) => new URL(r.url()).pathname === "/api/v1/snapshot",
  );
  await page.getByRole("button", { name: "Generate immutable change plan", exact: true }).click();
  const ackRecoveryResponse = await ackRecoveryPost;
  expect(ackRecoveryResponse.status()).toBe(200);
  const ackRecoveryPlan = (await ackRecoveryResponse.json()) as Snapshot["plans"][number];
  expect(ackRecoveryResponse.request().postDataJSON()).toEqual(admittedPlan.request);
  expect(ackRecoveryPlan.request).toEqual(admittedPlan.request);
  await ackRecoveryReadFailure;
  await expect(page.locator("#notice")).toContainText(`Plan ${ackRecoveryPlan.id} was created`);
  await expect(page.locator("#notice")).toContainText("Refresh explicitly");
  await expect(page.locator("#notice")).toContainText("No Apply");
  await expect(page.locator("#connect")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate immutable change plan", exact: true }),
  ).toBeEnabled();
  const ackRecoverySaved = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
  expect(ackRecoverySaved.plans).toHaveLength(ackRecoveryBefore.plans.length + 1);
  expect(ackRecoverySaved.plans).toContainEqual(ackRecoveryPlan);
  expect(ackRecoverySaved.operations).toEqual(ackRecoveryBefore.operations);
  for (const original of ackRecoveryBefore.plans)
    expect(ackRecoverySaved.plans.find((p) => p.id === original.id)).toEqual(original);
  const ackRecoveryCalls = localCalls.length;
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`acknowledged-plan-read-failure-${label}.png`),
      fullPage: true,
    });
  }
  expect(writes).toHaveLength(ackRecoveryWrites + 1);
  expect(localCalls).toHaveLength(ackRecoveryCalls);
  const ackRecoveryRefresh = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/snapshot",
  );
  await page.locator("#refresh").click();
  await (await ackRecoveryRefresh).json();
  await expect(page.locator("#notice")).toContainText("Updated.");
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", admittedPlan.id);
  await page.getByRole("link", { name: "Review existing change plans", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.locator("#plan-selection").selectOption(ackRecoveryPlan.id);
  await page.getByText("Technical plan identifiers & original evidence", { exact: true }).click();
  expect(JSON.parse(await page.locator("#plan-list article details pre").innerText())).toEqual(
    ackRecoveryPlan,
  );
  expect(writes).toHaveLength(ackRecoveryWrites + 1);

  await page.route("**/api/v1/snapshot", (route) => route.abort("failed"), { times: 1 });
  const ackRecoveryApply = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/v1/plans/${ackRecoveryPlan.id}/apply`,
  );
  const ackRecoveryApplyReadFailure = page.waitForEvent(
    "requestfailed",
    (r) => new URL(r.url()).pathname === "/api/v1/snapshot",
  );
  await page.getByRole("button", { name: "Apply reviewed plan", exact: true }).click();
  const ackRecoveryApplyResponse = await ackRecoveryApply;
  expect(ackRecoveryApplyResponse.status()).toBe(200);
  const ackRecoveryOperation = (await ackRecoveryApplyResponse.json()) as Snapshot["operations"][number];
  expect(ackRecoveryOperation.plan_id).toBe(ackRecoveryPlan.id);
  await ackRecoveryApplyReadFailure;
  await expect(page.locator("#notice")).toContainText(
    `Apply acknowledged operation ${ackRecoveryOperation.id}`,
  );
  await expect(page.locator("#notice")).toContainText("may continue independently");
  await expect(page.locator("#notice")).toContainText("Do not infer rollback");
  await expect(page.locator("#plans")).toBeVisible();
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    admittedOperation.id,
  );
  const ackRecoveryApplySaved = (await (
    await request.get("/api/v1/snapshot", { headers })
  ).json()) as Snapshot;
  expect(ackRecoveryApplySaved.operations).toHaveLength(ackRecoverySaved.operations.length + 1);
  expect(ackRecoveryApplySaved.operations.find((o) => o.id === ackRecoveryOperation.id)?.plan_id).toBe(
    ackRecoveryPlan.id,
  );
  expect(ackRecoveryApplySaved.plans).toEqual(ackRecoverySaved.plans);
  const ackRecoveryApplyCalls = localCalls.length;
  for (const [width, height, label] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`acknowledged-operation-read-failure-${label}.png`),
      fullPage: true,
    });
  }
  expect(writes).toHaveLength(ackRecoveryWrites + 2);
  expect(localCalls).toHaveLength(ackRecoveryApplyCalls);
  await expect
    .poll(async () => {
      const saved = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
      return saved.operations.find((o) => o.id === ackRecoveryOperation.id)?.status;
    })
    .toBe("succeeded");
  const ackRecoveryFinalRead = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/snapshot",
  );
  await page.locator("#refresh").click();
  const ackRecoveryFinalSnapshot = (await (await ackRecoveryFinalRead).json()) as Snapshot;
  await expect(page.locator("#notice")).toContainText("Updated.");
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    admittedOperation.id,
  );
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Operations", exact: true })
    .click();
  await expect(page.locator("#operations")).toBeVisible();
  const ackRecoverySelectionCalls = localCalls.length;
  await page.locator("#operation-selection").selectOption(ackRecoveryOperation.id);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    ackRecoveryOperation.id,
  );
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  expect(JSON.parse(await page.locator("#operation-list article details pre").innerText())).toEqual(
    ackRecoveryFinalSnapshot.operations.find((o) => o.id === ackRecoveryOperation.id),
  );
  expect(localCalls).toHaveLength(ackRecoverySelectionCalls);
  expect(writes).toHaveLength(ackRecoveryWrites + 2);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(ackRecoveryFinalSnapshot);

  // Retained DOM is a controlled lifecycle fixture, not corrupt HTTP or a cloud claim.
  // Keep every previous oracle; actual successful writes below still reach the real server.
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Connections / plans", exact: true })
    .click();
  await expect(page.locator("#connect")).toBeVisible();
  await page.getByRole("link", { name: "Review existing change plans", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.locator("#plan-selection").selectOption(ackRecoveryPlan.id);
  await page
    .getByRole("button", { name: "Configure another plan from original request", exact: true })
    .click();
  await expect(page.locator("#connection-configure")).toBeVisible();
  const lifecycleWrites = writes.length;
  const lifecycleGenerated = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  await page.getByRole("button", { name: "Generate immutable change plan", exact: true }).click();
  const lifecycleGeneratedResponse = await lifecycleGenerated;
  expect(lifecycleGeneratedResponse.status()).toBe(200);
  const lifecyclePlan = (await lifecycleGeneratedResponse.json()) as Snapshot["plans"][number];
  expect(lifecyclePlan.request).toEqual(ackRecoveryPlan.request);
  await expect(page.locator("#plans")).toBeVisible();
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", lifecyclePlan.id);
  await page.getByText("Technical plan identifiers & original evidence", { exact: true }).click();
  expect(JSON.parse(await page.locator("#plan-list article details pre").innerText())).toEqual(lifecyclePlan);
  const lifecycleBefore = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
  const lifecycleCalls = localCalls.length;
  await page.evaluate(async () => {
    const apply = document.querySelector<HTMLButtonElement>("#plan-list article button[data-write]");
    const card = apply?.closest("article"),
      review = card?.parentElement,
      mount = review?.parentElement;
    const elsewhere = document.getElementById("diagnostics");
    if (!apply || !card || !review || !mount || !elsewhere || apply.disabled)
      throw new Error("Missing current Apply fixture");
    const next = apply.nextSibling;
    for (const mode of ["remove-control", "move-control", "remove-review", "move-review"]) {
      if (mode === "remove-control") apply.remove();
      else if (mode === "move-control") elsewhere.append(apply);
      else if (mode === "remove-review") review.remove();
      else elsewhere.append(review);
      apply.dispatchEvent(new MouseEvent("click"));
      if (mode.endsWith("control")) card.insertBefore(apply, next);
      else mount.append(review);
    }
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(localCalls).toHaveLength(lifecycleCalls);
  expect(writes).toHaveLength(lifecycleWrites + 1);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(lifecycleBefore);
  const lifecycleApply = page.getByRole("button", { name: "Apply reviewed plan", exact: true });
  await expect(lifecycleApply).toBeEnabled();
  let releaseLifecycle!: () => void;
  const lifecycleGate = new Promise<void>((done) => {
    releaseLifecycle = done;
  });
  let lifecycleIntercepted = false;
  await page.route(
    `**/api/v1/plans/${lifecyclePlan.id}/apply`,
    async (route) => {
      lifecycleIntercepted = true;
      await lifecycleGate;
      await route.continue();
    },
    { times: 1 },
  );
  const lifecyclePost = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/v1/plans/${lifecyclePlan.id}/apply`,
  );
  const lifecycleFollowup = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/snapshot",
  );
  try {
    await lifecycleApply.click();
    await expect.poll(() => lifecycleIntercepted).toBe(true);
    await expect(lifecycleApply).toBeDisabled();
    await lifecycleApply.dispatchEvent("click");
    await lifecycleApply.dispatchEvent("click");
    expect(writes).toHaveLength(lifecycleWrites + 2);
    for (const [width, height, label] of [
      [1440, 1000, "desktop"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`original-apply-pending-${label}.png`),
        fullPage: true,
      });
    }
  } finally {
    releaseLifecycle();
  }
  const lifecyclePostResponse = await lifecyclePost;
  expect(lifecyclePostResponse.status()).toBe(200);
  expect(lifecyclePostResponse.request().postDataJSON()).toEqual({ fault: "none" });
  const lifecycleOperation = (await lifecyclePostResponse.json()) as Snapshot["operations"][number];
  expect(lifecycleOperation.plan_id).toBe(lifecyclePlan.id);
  const lifecycleSnapshot = (await (await lifecycleFollowup).json()) as Snapshot;
  await expect(page.locator("#operations")).toBeVisible();
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    lifecycleOperation.id,
  );
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  expect(JSON.parse(await page.locator("#operation-list article details pre").innerText())).toEqual(
    lifecycleSnapshot.operations.find((o) => o.id === lifecycleOperation.id),
  );
  const lifecycleSaved = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
  expect(lifecycleSaved.operations).toHaveLength(lifecycleBefore.operations.length + 1);
  expect(lifecycleSaved.operations.filter((o) => o.plan_id === lifecyclePlan.id)).toHaveLength(1);
  expect(lifecycleSaved.plans).toEqual(lifecycleBefore.plans);
  expect(lifecycleSaved.plans.find((p) => p.id === lifecyclePlan.id)).toEqual(lifecyclePlan);
  expect(writes).toHaveLength(lifecycleWrites + 2);

  // Reapplying this same Plan uses the existing server idempotent return, not a new operation claim.
  await page.locator("#operation-selection").selectOption(ackRecoveryOperation.id);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Connections / plans", exact: true })
    .click();
  await expect(page.locator("#connect")).toBeVisible();
  await page.getByRole("link", { name: "Review existing change plans", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.locator("#plan-selection").selectOption(lifecyclePlan.id);
  let releaseRetiredRead!: () => void;
  const retiredReadGate = new Promise<void>((done) => {
    releaseRetiredRead = done;
  });
  let retiredReadStarted = false;
  await page.route(
    "**/api/v1/snapshot",
    async (route) => {
      retiredReadStarted = true;
      await retiredReadGate;
      await route.continue();
    },
    { times: 1 },
  );
  const retiredPost = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/v1/plans/${lifecyclePlan.id}/apply`,
  );
  const retiredRead = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/snapshot",
  );
  try {
    await page.getByRole("button", { name: "Apply reviewed plan", exact: true }).click();
    const repeated = await retiredPost;
    expect(repeated.status()).toBe(200);
    expect((await repeated.json()).id).toBe(lifecycleOperation.id);
    await expect.poll(() => retiredReadStarted).toBe(true);
    await page.evaluate(() => {
      const review = document.querySelector("#plan-list article")?.parentElement;
      const elsewhere = document.getElementById("diagnostics");
      if (!review || !elsewhere) throw new Error("Missing pending review fixture");
      elsewhere.append(review);
    });
  } finally {
    releaseRetiredRead();
  }
  await (await retiredRead).json();
  await page.evaluate(() => new Promise((done) => setTimeout(done, 0)));
  await expect(page.locator("#plans")).toBeVisible();
  await expect(page.locator("#plan-list article")).toHaveCount(0);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    ackRecoveryOperation.id,
  );
  expect(writes).toHaveLength(lifecycleWrites + 3);
  await expect
    .poll(async () => {
      const saved = (await (await request.get("/api/v1/snapshot", { headers })).json()) as Snapshot;
      return saved.operations.find((o) => o.id === lifecycleOperation.id)?.status;
    })
    .toBe("succeeded");
  const manualRecovery = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/snapshot",
  );
  await page.locator("#refresh").click();
  const manualSnapshot = (await (await manualRecovery).json()) as Snapshot;
  await expect(page.locator("#notice")).toContainText("Updated.");
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", lifecyclePlan.id);
  const manualCalls = localCalls.length;
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Operations", exact: true })
    .click();
  await expect(page.locator("#operations")).toBeVisible();
  await page.locator("#operation-selection").selectOption(lifecycleOperation.id);
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  expect(JSON.parse(await page.locator("#operation-list article details pre").innerText())).toEqual(
    manualSnapshot.operations.find((o) => o.id === lifecycleOperation.id),
  );
  expect(localCalls).toHaveLength(manualCalls);
  expect(manualSnapshot.operations).toHaveLength(lifecycleBefore.operations.length + 1);
  expect(manualSnapshot.plans).toEqual(lifecycleBefore.plans);
  expect(writes).toHaveLength(lifecycleWrites + 3);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(manualSnapshot);

  // Original-operation DOM lifecycle fixture: real paired GETs and real demo POST only.
  const operationFramePath = `/api/v1/operations/${lifecycleOperation.id}`;
  const operationFrameRecord = manualSnapshot.operations.find((o) => o.id === lifecycleOperation.id);
  if (!operationFrameRecord) throw new Error("Missing persisted original operation fixture");
  const operationFrameInspect = () =>
    page
      .locator("#operation-list")
      .getByRole("button", { name: "Inspect result & step events", exact: true });
  const operationFrameDrift = () =>
    page.locator("#operation-list").getByRole("button", { name: "Simulate external drift", exact: true });
  const operationFrameObservation = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" && new URL(r.url()).pathname === `${operationFramePath}/observation`,
  );
  const operationFrameEvents = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `${operationFramePath}/events`,
  );
  await operationFrameInspect().click();
  const operationFrameObserved = await (await operationFrameObservation).json();
  const operationFrameRows = await (await operationFrameEvents).json();
  expect(operationFrameObserved.operation_id).toBe(lifecycleOperation.id);
  await expect(page.locator("#operation-events")).toHaveText(JSON.stringify(operationFrameRows, null, 2));
  await expect(operationFrameInspect()).toBeEnabled();
  await expect(operationFrameDrift()).toBeEnabled();
  const operationFrameDownload = page.locator("#operation-export [data-operation-export]");
  await expect(operationFrameDownload).toBeVisible();
  const operationFrameCalls = localCalls.length,
    operationFrameWrites = writes.length;
  const operationFrameEvidence = await page
    .locator("#observation, #operation-step-history, #operation-events, #operation-export")
    .evaluateAll((nodes) => nodes.map((n) => n.innerHTML));
  const operationFrameNotice = await page.locator("#notice").textContent();
  for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
    await page.evaluate((kind) => {
      const mount = document.getElementById("operation-list"),
        card = mount?.querySelector("article"),
        review = card?.parentElement,
        elsewhere = document.getElementById("diagnostics");
      if (!mount || !card || !review || !elsewhere) throw new Error("Missing original operation DOM fixture");
      for (const label of ["Inspect result & step events", "Simulate external drift"]) {
        const control = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
          (n) => n.textContent === label,
        );
        if (!control || control.disabled) throw new Error("Missing enabled original operation control");
        const next = control.nextSibling;
        if (kind === "removed-control") control.remove();
        else if (kind === "moved-control") elsewhere.append(control);
        else if (kind === "removed-review") review.remove();
        else elsewhere.append(review);
        control.dispatchEvent(new MouseEvent("click"));
        if (kind.endsWith("control")) card.insertBefore(control, next);
        else mount.append(review);
      }
    }, displacement);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    expect(localCalls).toHaveLength(operationFrameCalls);
    expect(writes).toHaveLength(operationFrameWrites);
    expect(
      await page
        .locator("#observation, #operation-step-history, #operation-events, #operation-export")
        .evaluateAll((nodes) => nodes.map((n) => n.innerHTML)),
    ).toEqual(operationFrameEvidence);
    await expect(page.locator("#notice")).toHaveText(operationFrameNotice ?? "");
  }
  const operationFrameSaved = page.waitForEvent("download");
  await operationFrameDownload.click();
  const operationFrameFile = testInfo.outputPath("original-operation-captured-inspection.json");
  await (await operationFrameSaved).saveAs(operationFrameFile);
  const operationFrameCaptured = JSON.parse(await readFile(operationFrameFile, "utf8"));
  expect(operationFrameCaptured.operation_snapshot).toEqual(operationFrameRecord);
  expect(operationFrameCaptured.observation).toEqual(operationFrameObserved);
  expect(operationFrameCaptured.events).toEqual(operationFrameRows);
  expect(operationFrameCaptured.provenance.atomic_capture).toBe(false);
  expect(operationFrameCaptured.provenance.connectivity).toBe("No measurement inferred by this export");
  expect(localCalls).toHaveLength(operationFrameCalls);
  expect(writes).toHaveLength(operationFrameWrites);

  // Hold a real backend observation response, not a synthetic API success.
  let operationReadReady!: () => void, operationReadRelease!: () => void;
  const operationReadEntered = new Promise<void>((done) => {
    operationReadReady = done;
  });
  const operationReadGate = new Promise<void>((done) => {
    operationReadRelease = done;
  });
  await page.route(`**${operationFramePath}/observation`, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    operationReadReady();
    await operationReadGate;
    await route.fulfill({ response });
  });
  const operationRetiredObservation = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" && new URL(r.url()).pathname === `${operationFramePath}/observation`,
  );
  await operationFrameInspect().click();
  await operationReadEntered;
  try {
    await expect(operationFrameInspect()).toBeDisabled();
    await expect(operationFrameDrift()).toBeDisabled();
    await expect(page.locator("#notice")).toHaveText("Working…");
    await expect(page.locator("#operation-export")).toBeEmpty();
    await expect(page.locator("#observation")).toBeEmpty();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: testInfo.outputPath("original-operation-inspect-pending-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("original-operation-inspect-pending-mobile.png"),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      const review = document.querySelector("#operation-list article")?.parentElement;
      if (!review) throw new Error("Missing retiring original operation review");
      review.remove();
    });
  } finally {
    operationReadRelease();
  }
  expect((await (await operationRetiredObservation).json()).operation_id).toBe(lifecycleOperation.id);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  await page.unroute(`**${operationFramePath}/observation`);
  expect(localCalls).toHaveLength(operationFrameCalls + 1);
  expect(writes).toHaveLength(operationFrameWrites);
  await expect(page.locator("#operation-list article")).toHaveCount(0);
  await expect(page.locator("#observation")).toBeEmpty();
  await expect(page.locator("#operation-events")).toBeEmpty();
  await expect(page.locator("#operation-export")).toBeEmpty();
  await expect(page.locator("#notice")).toHaveText("Working…");
  const operationFrameRefresh = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/snapshot");
  await page.locator("#refresh").click();
  expect(await (await operationFrameRefresh).json()).toEqual(manualSnapshot);
  await expect(operationFrameInspect()).toBeEnabled();
  await expect(operationFrameDrift()).toBeEnabled();
  await expect(page.locator("#operation-export")).toBeEmpty();
  expect(localCalls).toHaveLength(operationFrameCalls + 2);

  // Retire the original control after observation but before the paired real event response.
  let operationEventsReady!: () => void, operationEventsRelease!: () => void;
  const operationEventsEntered = new Promise<void>((done) => {
    operationEventsReady = done;
  });
  const operationEventsGate = new Promise<void>((done) => {
    operationEventsRelease = done;
  });
  await page.route(`**${operationFramePath}/events`, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    operationEventsReady();
    await operationEventsGate;
    await route.fulfill({ response });
  });
  const operationRetiredEvents = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `${operationFramePath}/events`,
  );
  await operationFrameInspect().click();
  await operationEventsEntered;
  try {
    await expect(page.locator("#observation")).toBeEmpty();
    await expect(page.locator("#operation-export")).toBeEmpty();
    await page.evaluate(() => {
      const control = [...document.querySelectorAll<HTMLButtonElement>("#operation-list button")].find(
        (n) => n.textContent === "Inspect result & step events",
      );
      if (!control) throw new Error("Missing retiring original Inspect control");
      control.remove();
    });
  } finally {
    operationEventsRelease();
  }
  expect(await (await operationRetiredEvents).json()).toEqual(operationFrameRows);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  await page.unroute(`**${operationFramePath}/events`);
  await expect(page.locator("#observation")).toBeEmpty();
  await expect(page.locator("#operation-events")).toBeEmpty();
  await expect(page.locator("#operation-export")).toBeEmpty();
  await expect(operationFrameDrift()).toBeDisabled();
  await expect(page.locator("#notice")).toHaveText("Working…");
  expect(localCalls).toHaveLength(operationFrameCalls + 4);
  expect(writes).toHaveLength(operationFrameWrites);

  const operationFrameRecover = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/snapshot");
  await page.locator("#refresh").click();
  expect(await (await operationFrameRecover).json()).toEqual(manualSnapshot);
  await expect(operationFrameDrift()).toBeEnabled();
  await expect(page.locator("#operation-export")).toBeEmpty();
  // A retired acknowledged demo mutation still persists; no cancellation/rollback is inferred.
  let operationDriftReady!: () => void, operationDriftRelease!: () => void;
  const operationDriftEntered = new Promise<void>((done) => {
    operationDriftReady = done;
  });
  const operationDriftGate = new Promise<void>((done) => {
    operationDriftRelease = done;
  });
  await page.route(`**${operationFramePath}/demo-drift`, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    operationDriftReady();
    await operationDriftGate;
    await route.fulfill({ response });
  });
  const operationDriftAcknowledged = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === `${operationFramePath}/demo-drift`,
  );
  const operationDriftCalls = localCalls.length;
  await operationFrameDrift().click();
  await operationDriftEntered;
  try {
    const actualDrift = await request.get(`${operationFramePath}/observation`, { headers });
    expect(actualDrift.ok()).toBe(true);
    expect((await actualDrift.json()).drift).toBe(true);
    await expect(operationFrameInspect()).toBeDisabled();
    await page.evaluate(() => {
      const control = [...document.querySelectorAll<HTMLButtonElement>("#operation-list button")].find(
        (n) => n.textContent === "Simulate external drift",
      );
      if (!control) throw new Error("Missing retiring original drift control");
      control.remove();
    });
  } finally {
    operationDriftRelease();
  }
  expect((await operationDriftAcknowledged).ok()).toBe(true);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  await page.unroute(`**${operationFramePath}/demo-drift`);
  expect(localCalls).toHaveLength(operationDriftCalls + 1);
  expect(writes).toHaveLength(operationFrameWrites + 1);
  await expect(page.locator("#observation")).toBeEmpty();
  await expect(page.locator("#operation-export")).toBeEmpty();
  await expect(page.locator("#notice")).toHaveText("Working…");
  const operationFinalRefresh = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/snapshot");
  await page.locator("#refresh").click();
  expect(await (await operationFinalRefresh).json()).toEqual(manualSnapshot);
  await expect(operationFrameInspect()).toBeEnabled();
  await expect(page.locator("#operation-export")).toBeEmpty();
  const operationFinalObservation = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" && new URL(r.url()).pathname === `${operationFramePath}/observation`,
  );
  const operationFinalEvents = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === `${operationFramePath}/events`,
  );
  await operationFrameInspect().click();
  expect((await (await operationFinalObservation).json()).drift).toBe(true);
  expect(await (await operationFinalEvents).json()).toEqual(operationFrameRows);
  await expect(page.locator("#operation-export [data-operation-export]")).toBeVisible();
  await expect(page.locator("#observation")).toContainText("Detected — no automatic repair");
  const operationFinalCalls = localCalls.length;
  await page.getByRole("button", { name: "Review original plan", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", lifecyclePlan.id);
  await page
    .locator("#plan-list")
    .getByText("Technical plan identifiers & original evidence", { exact: true })
    .click();
  expect(JSON.parse(await page.locator("#plan-list article details pre").innerText())).toEqual(lifecyclePlan);
  expect(localCalls).toHaveLength(operationFinalCalls);
  expect(writes).toHaveLength(operationFrameWrites + 1);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(manualSnapshot);

  // Original-history local actions: controlled DOM displacement, no new server mutation.
  {
    const historyCalls = localCalls.length,
      historyWrites = writes.length;
    for (const workspace of ["plans", "operations"]) {
      const kind = workspace === "plans" ? "plan" : "operation";
      await expect(page.locator(`#${workspace}`)).toBeVisible();
      await expect(page.locator(`#${kind}-list article`)).toHaveAttribute(
        `data-${kind}-id`,
        workspace === "plans" ? lifecyclePlan.id : lifecycleOperation.id,
      );
      const label = workspace === "plans" ? "Review recorded operation" : "Review original plan";
      const evidence = await page
        .locator("#observation, #operation-events, #operation-step-history, #operation-export")
        .evaluateAll((nodes) => nodes.map((n) => n.innerHTML));
      const notice = await page.locator("#notice").textContent();
      for (const displacement of ["removed-control", "moved-control", "removed-review", "moved-review"]) {
        await page.evaluate(
          ({ kind, label, displacement }) => {
            const mount = document.getElementById(`${kind}-list`),
              card = mount?.querySelector("article"),
              review = card?.parentElement,
              elsewhere = document.getElementById("diagnostics");
            const control = [...(card?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
              (n) => n.textContent === label,
            );
            if (!mount || !card || !review || !elsewhere || !control || control.disabled)
              throw new Error("Missing original local history fixture");
            const next = control.nextSibling;
            if (displacement === "removed-control") control.remove();
            else if (displacement === "moved-control") elsewhere.append(control);
            else if (displacement === "removed-review") review.remove();
            else elsewhere.append(review);
            control.dispatchEvent(new MouseEvent("click"));
            if (displacement.endsWith("control")) card.insertBefore(control, next);
            else mount.append(review);
          },
          { kind, label, displacement },
        );
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
        await expect(page.locator(`#${workspace}`)).toBeVisible();
        expect(localCalls).toHaveLength(historyCalls);
        expect(writes).toHaveLength(historyWrites);
        expect(
          await page
            .locator("#observation, #operation-events, #operation-step-history, #operation-export")
            .evaluateAll((nodes) => nodes.map((n) => n.innerHTML)),
        ).toEqual(evidence);
        await expect(page.locator("#notice")).toHaveText(notice ?? "");
      }
      if (workspace === "plans") {
        const downloads: string[] = [];
        const collectDownload = (download: { suggestedFilename(): string }) =>
          downloads.push(download.suggestedFilename());
        page.on("download", collectDownload);
        try {
          const blocked = await page.evaluate(() => {
            const mount = document.getElementById("plan-list"),
              card = mount?.querySelector("article"),
              review = card?.parentElement,
              elsewhere = document.getElementById("diagnostics");
            const download = card?.querySelector<HTMLButtonElement>("[data-plan-export]"),
              detail = card?.querySelector<HTMLElement>('[aria-label="Requested action detail"]'),
              link = card?.querySelector<HTMLAnchorElement>("[data-plan-review-link]");
            const next = [...(card?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
              (n) => n.textContent === "Next proposed action",
            );
            if (!mount || !review || !elsewhere || !download || !detail || !link || !next || next.disabled)
              throw new Error("Missing local original evidence fixture");
            const before = detail.dataset.actionIndex;
            elsewhere.append(review);
            let canceled = false;
            link.addEventListener(
              "click",
              (event) => {
                canceled = event.defaultPrevented;
                event.preventDefault();
              },
              { once: true },
            );
            link.dispatchEvent(new MouseEvent("click", { cancelable: true }));
            download.click();
            next.click();
            const after = detail.dataset.actionIndex;
            mount.append(review);
            return { before, after, canceled };
          });
          expect(blocked.before).toBe("0");
          expect(blocked.after).toBe(blocked.before);
          expect(blocked.canceled).toBe(true);
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
          expect(downloads).toEqual([]);
        } finally {
          page.off("download", collectDownload);
        }
        await page
          .locator("#plan-list")
          .getByRole("button", { name: "Next proposed action", exact: true })
          .click();
        await expect(page.locator('#plan-list [aria-label="Requested action detail"]')).toHaveAttribute(
          "data-action-index",
          "1",
        );
        await expect(page.locator("#plan-list [data-proposed-target]")).toHaveText(
          lifecyclePlan.actions[1]?.target ?? "missing original target",
        );
        // Collapse only the already-open original technical disclosure through its ordinary control.
        await page
          .locator("#plan-list")
          .getByText("Technical plan identifiers & original evidence", { exact: true })
          .click();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({
          path: testInfo.outputPath("history-local-plan-evidence-desktop.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: testInfo.outputPath("history-local-plan-evidence-mobile.png"),
          fullPage: true,
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        const downloaded = page.waitForEvent("download");
        await page
          .locator("#plan-list")
          .getByRole("button", { name: "Download original plan JSON", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        const file = await downloaded,
          destination = testInfo.outputPath("history-local-original-plan.json");
        expect(file.suggestedFilename()).toBe("navarchnet-plan.json");
        await file.saveAs(destination);
        expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(lifecyclePlan);
      }
      await page.locator(`#${kind}-list`).getByRole("button", { name: label, exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(workspace === "plans" ? "#operations" : "#plans")).toBeVisible();
      expect(localCalls).toHaveLength(historyCalls);
      expect(writes).toHaveLength(historyWrites);
    }
    // A refused local navigation must not retire the still-current original pending read.
    await page
      .locator("#plan-list")
      .getByRole("button", { name: "Review recorded operation", exact: true })
      .click();
    await expect(page.locator("#operations")).toBeVisible();
    let historyReadReady!: () => void, historyReadRelease!: () => void;
    const historyReadEntered = new Promise<void>((done) => {
      historyReadReady = done;
    });
    const historyReadGate = new Promise<void>((done) => {
      historyReadRelease = done;
    });
    await page.route(`**${operationFramePath}/observation`, async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      historyReadReady();
      await historyReadGate;
      await route.fulfill({ response });
    });
    const historyObservation = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `${operationFramePath}/observation`,
    );
    const historyEvents = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `${operationFramePath}/events`,
    );
    await operationFrameInspect().click();
    await historyReadEntered;
    try {
      const current = await page.evaluate(() => {
        const mount = document.getElementById("operation-list"),
          card = mount?.querySelector("article"),
          review = card?.parentElement,
          elsewhere = document.getElementById("diagnostics");
        const local = [...(card?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
          (n) => n.textContent === "Review original plan",
        );
        if (!mount || !review || !elsewhere || !local || local.disabled)
          throw new Error("Missing pending local review fixture");
        elsewhere.append(review);
        local.click();
        const hash = location.hash,
          notice = document.getElementById("notice")?.textContent;
        mount.append(review);
        return { hash, notice };
      });
      expect(current.hash).toBe("#/operations");
      expect(current.notice).toBe("Working…");
      await expect(operationFrameInspect()).toBeDisabled();
    } finally {
      historyReadRelease();
    }
    expect((await (await historyObservation).json()).operation_id).toBe(lifecycleOperation.id);
    expect(await (await historyEvents).json()).toEqual(operationFrameRows);
    await expect(page.locator("#operation-export [data-operation-export]")).toBeVisible();
    await expect(operationFrameInspect()).toBeEnabled();
    await page.unroute(`**${operationFramePath}/observation`);
    expect(localCalls).toHaveLength(historyCalls + 2);
    expect(writes).toHaveLength(historyWrites);
    await page
      .locator("#operation-list")
      .getByText("Technical operation identifiers & persisted state", { exact: true })
      .click();
    expect(JSON.parse(await page.locator("#operation-list article details pre").innerText())).toEqual(
      operationFrameRecord,
    );
    await page
      .locator("#operation-list")
      .getByRole("button", { name: "Review original plan", exact: true })
      .click();
    await expect(page.locator("#plans")).toBeVisible();
    expect(
      JSON.parse((await page.locator("#plan-list article details pre").textContent()) ?? "null"),
    ).toEqual(lifecyclePlan);
    expect(localCalls).toHaveLength(historyCalls + 2);
    expect(writes).toHaveLength(historyWrites);
    expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(manualSnapshot);
  }
});

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
});

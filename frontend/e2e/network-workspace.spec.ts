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
});

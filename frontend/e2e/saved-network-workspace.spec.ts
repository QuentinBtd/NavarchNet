import { expect, test } from "@playwright/test";
import type { Snapshot, TopologyView } from "../src/generated";

test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: saved AWS records have a capture-bound map and readonly inspector", async ({
  page,
  request,
}, testInfo) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const snapshot = async () => {
    const response = await request.get("/api/v1/snapshot", { headers });
    expect(response.status()).toBe(200);
    return (await response.json()) as Snapshot;
  };
  const before = await snapshot();
  expect(before.aws_read_only_enabled).toBe(false);
  const account = before.aws_accounts.find((a) => a.name === "Browser saved TGW B");
  const other = before.aws_accounts.find((a) => a.name === "Browser saved TGW A");
  if (!account || !other) throw new Error("Saved fixture registrations missing");
  const saved = async () => {
    const response = await request.get(`/api/v1/aws/accounts/${account.id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return (await response.json()) as TopologyView;
  };
  const view = await saved();
  expect(view.topology.execution_enabled).toBe(false);
  expect(view.topology.connectivity_tested).toBe(false);
  expect(view.topology.account_id).toBe(account.id);
  const index = view.topology.resources.findIndex((r) => r.id === "nat-browser-regional");
  expect(index).toBeGreaterThanOrEqual(0);
  const record = view.topology.resources[index];
  expect(record.nat_gateway?.addresses?.map((a) => a.status)).toEqual([
    "succeeded",
    "failed",
    "future-<img src=x>",
  ]);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await page.goto("/#/aws");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const open = async (name: string) => {
    await page
      .locator("#aws-account-list li")
      .filter({ hasText: name })
      .getByRole("button", { name: "View saved AWS observation", exact: true })
      .click();
  };
  await open(account.name);
  // Original saved bytes/registration/tuple fixture/false markers are established before UI RED.
  const map = page.getByRole("region", { name: "Saved AWS resource map", exact: true });
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  await expect(map).toHaveAttribute("data-completed-at", view.topology.completed_at);
  await page.getByLabel("Observed resource kind", { exact: true }).selectOption("nat_gateway");
  await map.locator(`button[data-record-index="${index}"]`).click();
  const inspector = map.getByRole("complementary", { name: "Saved AWS record inspector" });
  await expect(inspector).toContainText(record.id);
  await expect(inspector).toContainText("Reported metadata is not health or a usable path");
  await inspector.getByText("Original captured record", { exact: true }).click();
  expect(JSON.parse(await inspector.locator("pre").innerText())).toEqual(record);
  await expect(inspector).toContainText("future-<img src=x>");
  await expect(map.locator("img,svg path,form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authorize metadata adoption" })).toHaveCount(0);
  await inspector.getByText("Original captured record", { exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await map.screenshot({ path: testInfo.outputPath("saved-aws-workspace-running-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await map.screenshot({ path: testInfo.outputPath("saved-aws-workspace-running-mobile.png") });
  await open(other.name);
  await expect(map).not.toHaveAttribute("data-topology-id", view.topology.id);
  await open(account.name);
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  expect(await saved()).toEqual(view);
  expect(await snapshot()).toEqual(before);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
});

test("real browser: map inspector retains original saved VPC and TGW route entries", async ({
  page,
  request,
}, testInfo) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const beforeResponse = await request.get("/api/v1/snapshot", { headers });
  expect(beforeResponse.status()).toBe(200);
  const before = (await beforeResponse.json()) as Snapshot;
  expect(before.aws_read_only_enabled).toBe(false);
  const account = before.aws_accounts.find((a) => a.name === "Browser saved TGW A");
  if (!account) throw new Error("Saved registration missing");
  const saved = async () => {
    const response = await request.get(`/api/v1/aws/accounts/${account.id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return (await response.json()) as TopologyView;
  };
  const view = await saved();
  expect(view.topology.account_id).toBe(account.id);
  expect(view.topology.execution_enabled).toBe(false);
  expect(view.topology.connectivity_tested).toBe(false);
  const records = ["route_table", "transit_gateway_route_table"].map((kind) => {
    const index = view.topology.resources.findIndex(
      (r) =>
        r.kind === kind && (kind === "route_table" ? r.routes.length > 0 : (r.tgw_routes?.length ?? 0) > 0),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const record = view.topology.resources[index];
    const routes = kind === "route_table" ? record.routes : record.tgw_routes;
    if (!routes?.length) throw new Error("Stored route collection missing");
    return { kind, index, record, routes };
  });
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await page.goto("/#/aws");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: account.name })
    .getByRole("button", { name: "View saved AWS observation", exact: true })
    .click();
  const map = page.getByRole("region", { name: "Saved AWS resource map", exact: true });
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  for (const { kind, index, record, routes } of records) {
    await map.getByLabel("Observed resource kind", { exact: true }).selectOption(kind);
    await map.locator(`button[data-record-index="${index}"]`).click();
    const inspector = map.getByRole("complementary", { name: "Saved AWS record inspector" });
    await expect(inspector).toContainText(record.id);
    // Both original real stored collections and false markers are established before missing-control RED.
    await expect(inspector.getByText("Reported route entries", { exact: true })).toBeVisible();
    await inspector.getByText("Reported route entries", { exact: true }).click();
    const detail = inspector.locator("details[data-captured-route-entries]");
    await expect(detail).toHaveAttribute("data-capture-id", view.topology.id);
    await expect(detail).toHaveAttribute("data-resource-index", String(index));
    await expect(detail).toContainText("Not effective routing or measured traffic");
    for (let shown = 12; shown < routes.length; shown += 12)
      await detail.getByRole("button", { name: "Show more captured routes", exact: true }).click();
    const rows = detail.locator("li[data-route-index]");
    await expect(rows).toHaveCount(routes.length);
    for (let i = 0; i < routes.length; i++) {
      const row = rows.nth(i);
      await expect(row).toHaveAttribute("data-route-index", String(i));
      await row.getByText("Original route record", { exact: true }).click();
      expect(JSON.parse(await row.locator("pre").innerText())).toEqual(routes[i]);
      await row.getByText("Original route record", { exact: true }).click();
    }
    await expect(detail.locator("form,input,select,a,img")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1080 });
    expect((await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(
      ((await map.boundingBox())?.width ?? 0) * 0.35,
    );
    await map.screenshot({ path: testInfo.outputPath(`captured-${kind}-routes-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await map.screenshot({ path: testInfo.outputPath(`captured-${kind}-routes-mobile.png`) });
  }
  expect(await saved()).toEqual(view);
  const afterResponse = await request.get("/api/v1/snapshot", { headers });
  expect(afterResponse.status()).toBe(200);
  expect(await afterResponse.json()).toEqual(before);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
});

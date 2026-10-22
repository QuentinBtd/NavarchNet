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

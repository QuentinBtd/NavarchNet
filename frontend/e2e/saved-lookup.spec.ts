import { expect, test } from "@playwright/test";

// A separately seeded UUID PostgreSQL schema, served by the actual current production binary.
// No mocked browser responses, AWS SDK access, onboarding bypass endpoint or cloud credentials.
test.use({ baseURL: "http://127.0.0.1:18083" });

test("real browser: reader looks up saved TGW forward, blackhole and unresolved results with SDK off", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const beforeResponse = await request.get("/api/v1/snapshot", { headers });
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json();
  expect(before.role).toBe("read_only");
  expect(before.aws_read_only_enabled).toBe(false);
  expect(before.aws_accounts).toHaveLength(2);
  const accountA = before.aws_accounts.find(
    (account: { name: string }) => account.name === "Browser saved TGW A",
  );
  expect(accountA).toBeDefined();
  const path = `/api/v1/aws/accounts/${accountA.id}/topology`;
  const savedResponse = await request.get(path, { headers });
  expect(savedResponse.status()).toBe(200);
  const savedBefore = await savedResponse.json();
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#aws-access")).toContainText("AWS SDK access is disabled");
  await expect(page.locator("#aws-register")).toBeHidden();
  const account = page.locator("#aws-account-list li").filter({ hasText: "Browser saved TGW A" });
  await account.getByRole("button", { name: "View saved AWS observation" }).click();
  const card = page.locator("#aws-topology article").filter({ hasText: "tgw-rtb-browser-a" });
  await expect(card).toHaveCount(1);
  await card.getByText("Observed TGW table relationships", { exact: true }).click();
  const form = card.locator("form[data-route-lookup]");
  const input = form.getByLabel("Destination IP (saved TGW table lookup)");
  const submit = form.getByRole("button", { name: "Look up saved TGW route" });
  for (const [destination, expected] of [
    ["203.0.113.1", "Reported table match: 203.0.113.1 → 0.0.0.0/0"],
    ["10.2.3.4", "Reported blackhole: 10.2.3.4 → 10.2.0.0/16"],
    ["not-an-ip", "Unresolved: invalid_destination"],
  ]) {
    await input.fill(destination);
    const response = page.waitForResponse((response) => response.url().includes("/tgw-route-lookup?"));
    await submit.click();
    const received = await response;
    expect(received.status()).toBe(200);
    const body = await received.json();
    expect(body.topology_id).toBe(savedBefore.topology.id);
    expect(body.route_table_id).toBe("tgw-rtb-browser-a");
    expect(body.destination).toBe(destination);
    expect(body.execution_enabled).toBe(false);
    expect(body.connectivity_tested).toBe(false);
    await expect(form.getByRole("status")).toContainText(expected);
    await expect(form.getByRole("status")).toContainText("not a full path or measured connectivity");
    await expect(submit).toBeEnabled();
    await input.fill("203.0.113.250");
    await expect(form.getByRole("status")).not.toContainText("Reported table match");
    await expect(form.getByRole("status")).toContainText("run another saved lookup");
  }
  await expect(page.locator("#aws-topology")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#aws-topology img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authorize metadata adoption" })).toHaveCount(0);
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: "Browser saved TGW B" })
    .getByRole("button", { name: "View saved AWS observation" })
    .click();
  await expect(page.locator("#aws-topology")).toContainText("tgw-rtb-browser-b");
  await expect(page.locator("#aws-topology")).not.toContainText("Reported table match");
  const afterResponse = await request.get("/api/v1/snapshot", { headers });
  expect(afterResponse.status()).toBe(200);
  const after = await afterResponse.json();
  expect(after.aws_accounts).toEqual(before.aws_accounts);
  expect(after.plans).toEqual(before.plans);
  expect(after.inventory).toEqual(before.inventory);
  const savedAfterResponse = await request.get(path, { headers });
  expect(savedAfterResponse.status()).toBe(200);
  expect(await savedAfterResponse.json()).toEqual(savedBefore);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
  await expect(page.locator("#workspace")).toBeHidden();
});

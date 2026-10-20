import { expect, test } from "@playwright/test";

test("real browser: register, discover, plan, apply, observe drift and partial failure", async ({ page }) => {
  const name = `Browser app ${Date.now()}`;
  const network = `Browser egress ${Date.now()}`;
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-admin-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.getByLabel("Account name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Register fake account" }).click();
  const account = page.locator("#account-list li").filter({ hasText: name });
  await expect(account).toBeVisible();
  await account.getByRole("button", { name: "Discover VPCs" }).click();
  await expect(page.locator("#vpc option").filter({ hasText: name })).toHaveCount(1);
  const vpc = await page.locator("#vpc option").filter({ hasText: name }).getAttribute("value");
  if (!vpc) throw new Error("Discovered VPC missing");
  await page.getByLabel("Discovered VPC", { exact: true }).selectOption(vpc);
  await page.getByLabel("Network name", { exact: true }).fill(network);
  await page.getByRole("button", { name: "Create simulated regional network" }).click();
  await expect(page.locator("#network option").filter({ hasText: network })).toHaveCount(1);
  const networkId = await page.locator("#network option").filter({ hasText: network }).getAttribute("value");
  if (!networkId) throw new Error("Created network missing");
  await page.getByLabel("Regional egress network").selectOption(networkId);
  await page.getByRole("button", { name: "Generate immutable change plan" }).click();
  const plan = page.locator("#plan-list article").first();
  await expect(plan).toContainText(vpc);
  await expect(plan).toContainText("return_route");
  await page.getByLabel("Demo execution scenario").selectOption("throttle");
  await plan.getByRole("button", { name: "Apply reviewed plan" }).click();
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      return page.locator("#operation-list article").first().textContent();
    })
    .toContain("Simulation converged");
  let operation = page.locator("#operation-list article").first();
  await operation.getByRole("button", { name: "Inspect result & step events" }).click();
  await expect(page.locator("#observation")).toContainText("Not tested");
  await operation.getByRole("button", { name: "Simulate external drift" }).click();
  await expect(page.locator("#observation")).toContainText("Detected — no automatic repair");
  await page.getByRole("button", { name: "Generate immutable change plan" }).click();
  await page.getByLabel("Demo execution scenario").selectOption("partial_failure");
  await page
    .locator("#plan-list article")
    .first()
    .getByRole("button", { name: "Apply reviewed plan" })
    .click();
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      return page.locator("#operation-list article").first().textContent();
    })
    .toContain("Partial completion");
  operation = page.locator("#operation-list article").first();
  await expect(operation).toContainText("Conflicting manual NAT route");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#account-list")).toBeEmpty();
});

test("read-only session cannot mutate through UI or API", async ({ page, request }) => {
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Register fake account" })).toBeDisabled();
  const response = await request.post("/api/v1/accounts", {
    headers: { Authorization: "Bearer browser-test-reader-credential-free-local-only" },
    data: { name: "Forbidden", provider: "fake", role_arn: "fake:role" },
  });
  expect(response.status()).toBe(403);
});

test("real browser demo keeps AWS off and rejects role onboarding without changing saved metadata", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-admin-credential-free-local-only" };
  const before = await (await request.get("/api/v1/snapshot", { headers })).json();
  const catalog = await request.get("/api/v1/aws/accounts", { headers });
  expect(catalog.status()).toBe(200);
  expect(await catalog.json()).toEqual(before.aws_accounts);
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-admin-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#aws-access")).toContainText("AWS SDK access is disabled");
  await expect(page.locator("#aws-register")).toBeHidden();
  const response = await request.post("/api/v1/aws/accounts", {
    headers,
    data: {
      name: "Rejected fixture",
      role_arn: "arn:aws:iam::123456789012:role/Reader",
      region: "eu-west-1",
      external_id: null,
    },
  });
  expect(response.status()).toBe(409);
  expect((await response.json()).error).toContain("disabled");
  const after = await (await request.get("/api/v1/snapshot", { headers })).json();
  expect(after.aws_read_only_enabled).toBe(false);
  expect(after.aws_accounts.length).toBe(before.aws_accounts.length);
});

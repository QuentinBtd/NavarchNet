import { expect, test } from "@playwright/test";
import type { Snapshot } from "../src/generated";

test("real browser: register, discover, plan, apply, observe drift and partial failure", async ({
  page,
}, testInfo) => {
  const name = `Browser app ${Date.now()}`;
  const network = `Browser egress ${Date.now()}`;
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-admin-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Accounts & discovery", exact: true })
    .click();
  await page.getByText("Register simulation account", { exact: true }).click();
  await page.getByLabel("Account name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Register fake account" }).click();
  const account = page.locator("#account-list li").filter({ hasText: name });
  await expect(account).toBeVisible();
  await account.getByRole("button", { name: "Discover VPCs" }).click();
  await expect(page.locator("#vpc option").filter({ hasText: name })).toHaveCount(1);
  const vpc = await page.locator("#vpc option").filter({ hasText: name }).getAttribute("value");
  if (!vpc) throw new Error("Discovered VPC missing");
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Regional networks", exact: true })
    .click();
  await page.getByText("Create regional network", { exact: true }).click();
  await page.getByLabel("Network name", { exact: true }).fill(network);
  await page.getByRole("button", { name: "Create simulated regional network" }).click();
  await expect(page.locator("#network option").filter({ hasText: network })).toHaveCount(1);
  const networkId = await page.locator("#network option").filter({ hasText: network }).getAttribute("value");
  if (!networkId) throw new Error("Created network missing");
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Connections / plans", exact: true })
    .click();
  await page.getByLabel("Discovered VPC", { exact: true }).selectOption(vpc);
  await expect(page.locator("#connection-configure")).toBeHidden();
  await page.getByRole("button", { name: "Configure connection", exact: true }).click();
  await expect(page.locator("#connection-select")).toBeHidden();
  await page.getByLabel("Regional egress network").selectOption(networkId);
  const firstCreated = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  await page.getByRole("button", { name: "Generate immutable change plan" }).click();
  const firstSaved = await (await firstCreated).json();
  const plan = page.locator("#plan-list article").first();
  await expect(plan).toContainText(vpc);
  await expect(plan).toContainText("return_route");
  await expect(page).toHaveURL(/#\/plans$/);
  await expect(page.locator("[data-workspace]:visible")).toHaveCount(1);
  await expect(plan).toHaveAttribute("data-plan-id", firstSaved.id);
  const impact = plan.getByRole("region", { name: "Plan impact comparison", exact: true });
  await expect(impact).toBeVisible();
  await expect(impact).toHaveAttribute("data-plan-id", firstSaved.id);
  await expect(impact).toHaveAttribute("data-plan-digest", firstSaved.digest);
  await expect(impact).toContainText("Original route targets are not stored in this plan");
  for (const action of firstSaved.actions)
    await expect(impact.locator(`[data-action-kind="${action.kind}"]`)).toContainText(action.target);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("compact-plan-review.png"), fullPage: true });
  await page.getByLabel("Demo execution scenario").selectOption("throttle");
  const firstApplied = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/plans/${firstSaved.id}/apply`,
  );
  await plan.getByRole("button", { name: "Apply reviewed plan" }).click();
  const firstApplyResponse = await firstApplied;
  expect(firstApplyResponse.status()).toBe(200);
  const firstOperation = await firstApplyResponse.json();
  expect(typeof firstOperation.id).toBe("string");
  let operation = page.locator("#operation-list article").filter({ hasText: firstOperation.id });
  const refreshOperationSnapshot = async (): Promise<Snapshot> => {
    await expect(page.locator("#operations")).toBeVisible();
    const refreshed = page.waitForResponse(
      (r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/snapshot",
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const response = await refreshed;
    expect(response.status()).toBe(200);
    const value = (await response.json()) as Snapshot;
    // A click or response header does not mean the new view has been published.
    await expect(page.locator("#notice")).toHaveText(
      "Updated. Configuration observations are not connectivity measurements.",
    );
    return value;
  };
  await expect
    .poll(async () => {
      await refreshOperationSnapshot();
      return operation.textContent();
    })
    .toContain("Simulation converged");
  await operation.getByRole("button", { name: "Inspect result & step events" }).click();
  await expect(page.locator("#observation")).toContainText("Not tested");
  await operation.getByRole("button", { name: "Simulate external drift" }).click();
  await expect(page.locator("#observation")).toContainText("Detected — no automatic repair");
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Connections / plans", exact: true })
    .click();
  const secondCreated = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/plans",
  );
  const secondSnapshot = page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/snapshot",
  );
  await page.getByRole("button", { name: "Generate immutable change plan" }).click();
  const secondSaved = await (await secondCreated).json();
  await expect(page).toHaveURL(/#\/plans$/);
  await expect(page.locator("#plan-list article")).toHaveCount(1);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", secondSaved.id);
  const selection = page.getByLabel("Plan to review", { exact: true });
  const returnedSnapshot = (await (await secondSnapshot).json()) as Snapshot;
  const returnedIds = returnedSnapshot.plans.map((p) => p.id);
  expect(returnedIds).toContain(firstSaved.id);
  expect(returnedIds).toContain(secondSaved.id);
  await expect(selection.locator("option")).toHaveCount(returnedIds.length);
  expect(
    await selection
      .locator("option")
      .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value)),
  ).toEqual(returnedIds);
  const selectionCalls: string[] = [];
  page.on("request", (r) => selectionCalls.push(r.url()));
  await selection.selectOption(firstSaved.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", firstSaved.id);
  await expect(page.locator("#plan-list details")).not.toHaveAttribute("open");
  await page.getByText("Technical plan identifiers & original evidence", { exact: true }).click();
  expect(JSON.parse(await page.locator("#plan-list details pre").innerText())).toEqual(firstSaved);
  await selection.selectOption(secondSaved.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", secondSaved.id);
  expect(selectionCalls).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("selected-plan-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(
    await page.evaluate(() => {
      const navigation = document.querySelector(".sidebar nav");
      const mode = document.querySelector(".mode-status");
      if (!navigation || !mode) throw new Error("Missing navigation/mode status");
      return navigation.getBoundingClientRect().bottom <= mode.getBoundingClientRect().top;
    }),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("selected-plan-review.png"), fullPage: true });
  await page.getByLabel("Demo execution scenario").selectOption("partial_failure");
  const applied = page.waitForRequest(
    (r) => r.method() === "POST" && new URL(r.url()).pathname.endsWith("/apply"),
  );
  const secondApplied = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/v1/plans/${secondSaved.id}/apply`,
  );
  await page
    .locator("#plan-list article")
    .first()
    .getByRole("button", { name: "Apply reviewed plan" })
    .click();
  const appliedRequest = await applied;
  expect(new URL(appliedRequest.url()).pathname).toBe(`/api/v1/plans/${secondSaved.id}/apply`);
  expect(appliedRequest.postDataJSON()).toEqual({ fault: "partial_failure" });
  const secondApplyResponse = await secondApplied;
  expect(secondApplyResponse.status()).toBe(200);
  const secondOperation = await secondApplyResponse.json();
  expect(typeof secondOperation.id).toBe("string");
  operation = page.locator("#operation-list article").filter({ hasText: secondOperation.id });
  let operationSnapshot: Snapshot | undefined;
  await expect
    .poll(async () => {
      operationSnapshot = await refreshOperationSnapshot();
      return operation.textContent();
    })
    .toContain("Partial completion");
  await expect(operation).toContainText("Conflicting manual NAT route");
  await expect(page).toHaveURL(/#\/operations$/);
  await expect(page.locator("#operation-list article")).toHaveCount(1);
  if (!operationSnapshot) throw new Error("Missing refreshed operation history");
  const operationIds = operationSnapshot.operations.map((value) => value.id);
  expect(operationIds).toContain(firstOperation.id);
  expect(operationIds).toContain(secondOperation.id);
  const operationSelection = page.getByLabel("Operation to inspect", { exact: true });
  await expect(operationSelection.locator("option")).toHaveCount(operationIds.length);
  expect(
    await operationSelection
      .locator("option")
      .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value)),
  ).toEqual(operationIds);
  const localOperationSelectionCalls: string[] = [];
  page.on("request", (r) => localOperationSelectionCalls.push(r.url()));
  await operationSelection.selectOption(firstOperation.id);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    firstOperation.id,
  );
  await operationSelection.selectOption(secondOperation.id);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    secondOperation.id,
  );
  expect(localOperationSelectionCalls).toEqual([]);
  const observed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/v1/operations/${secondOperation.id}/observation`,
  );
  const eventResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/v1/operations/${secondOperation.id}/events`,
  );
  await operation.getByRole("button", { name: "Inspect result & step events" }).click();
  const observedBody = await (await observed).json();
  const eventBody = await (await eventResponse).json();
  expect(observedBody.operation_id).toBe(secondOperation.id);
  await expect(page.locator("#observation")).toContainText(observedBody.configuration);
  await expect(page.locator("#observation")).toContainText("Not tested");
  await page.getByText("Technical step events for the selected operation", { exact: true }).click();
  expect(JSON.parse(await page.locator("#operation-events").innerText())).toEqual(eventBody);
  await page.getByText("Technical step events for the selected operation", { exact: true }).click();
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  expect(JSON.parse(await page.locator("#operation-list details pre").innerText())).toEqual(
    operationSnapshot.operations.find((value) => value.id === secondOperation.id),
  );
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("selected-operation-review.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("selected-operation-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#account-list")).toBeEmpty();

  // Original mutation/drift/history/logout assertions above stay unchanged.
  // Review exact persisted request scope as a reader, not current inventory or inferred routes.
  await page.goto("/#/plans");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.getByLabel("Plan to review", { exact: true }).selectOption(firstSaved.id);
  const exactImpact = page.getByRole("region", { name: "Plan impact comparison", exact: true });
  await expect(exactImpact).toHaveAttribute("data-plan-id", firstSaved.id);
  await expect(exactImpact).toHaveAttribute("data-plan-digest", firstSaved.digest);
  expect(firstSaved.request.subnet_ids.length).toBeGreaterThan(0);
  // Real returned immutable plan established before the missing visible-scope RED.
  await expect(exactImpact.getByText("Requested attachment subnets", { exact: true })).toBeVisible();
  await expect(exactImpact.locator("[data-request-account]")).toHaveText(firstSaved.request.account_id);
  expect(await exactImpact.locator("[data-request-subnets] li").allTextContents()).toEqual(
    firstSaved.request.subnet_ids,
  );
  await expect(exactImpact).toContainText("Original route targets are not stored in this plan");
  await expect(page.getByRole("button", { name: "Apply reviewed plan", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await exactImpact.screenshot({ path: testInfo.outputPath("plan-request-scope-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await exactImpact.screenshot({ path: testInfo.outputPath("plan-request-scope-mobile.png") });
});

test("read-only session cannot mutate through UI or API", async ({ page, request }) => {
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Accounts & discovery", exact: true })
    .click();
  await page.getByText("Register simulation account", { exact: true }).click();
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
  await page.goto("/#/aws");
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

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

  // All original journey and exact request-scope assertions above remain unchanged.
  // A different preselected plan makes an accidental generic/default navigation observable.
  expect(secondOperation.plan_id).toBe(secondSaved.id);
  expect(secondSaved.id).not.toBe(firstSaved.id);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Operations", exact: true })
    .click();
  await expect(page.locator("#operations")).toBeVisible();
  await page.getByLabel("Operation to inspect", { exact: true }).selectOption(secondOperation.id);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    secondOperation.id,
  );
  const originalPlanAction = page.getByRole("button", { name: "Review original plan", exact: true });
  await expect(originalPlanAction).toBeVisible();
  await expect(originalPlanAction).toBeEnabled();
  const reviewCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/")) reviewCalls.push(r.url());
  });
  await originalPlanAction.click();
  await expect(page.locator("#plans")).toBeVisible();
  await expect(exactImpact).toHaveAttribute("data-plan-id", secondSaved.id);
  await expect(exactImpact).toHaveAttribute("data-plan-digest", secondSaved.digest);
  await expect(exactImpact.locator("[data-request-account]")).toHaveText(secondSaved.request.account_id);
  expect(await exactImpact.locator("[data-request-subnets] li").allTextContents()).toEqual(
    secondSaved.request.subnet_ids,
  );
  await expect(exactImpact).toContainText("Original route targets are not stored in this plan");
  await expect(page.getByRole("button", { name: "Apply reviewed plan", exact: true })).toBeDisabled();
  expect(reviewCalls).toEqual([]);
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await exactImpact.screenshot({ path: testInfo.outputPath(`operation-plan-handoff-${label}.png`) });
  }

  // Every original journey, scope and operation-to-plan oracle above remains unchanged.
  // The reciprocal handoff must not reuse a different preselected operation.
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Operations", exact: true })
    .click();
  await expect(page.locator("#operations")).toBeVisible();
  await page.getByLabel("Operation to inspect", { exact: true }).selectOption(firstOperation.id);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    firstOperation.id,
  );
  await page.getByRole("button", { name: "Review original plan", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.getByLabel("Plan to review", { exact: true }).selectOption(secondSaved.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", secondSaved.id);
  await expect(page.getByRole("button", { name: "Apply reviewed plan", exact: true })).toBeDisabled();
  const readerHeaders = { authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const beforeHandoffResponse = await page.request.get("/api/v1/snapshot", { headers: readerHeaders });
  expect(beforeHandoffResponse.ok()).toBe(true);
  const beforeHandoff = (await beforeHandoffResponse.json()) as Snapshot;
  const exactOperations = beforeHandoff.operations.filter((o) => o.plan_id === secondSaved.id);
  expect(exactOperations).toHaveLength(1);
  expect(exactOperations[0]?.id).toBe(secondOperation.id);
  expect(secondOperation.id).not.toBe(firstOperation.id);
  const handoffCalls = reviewCalls.length;
  const recordedOperationAction = page.getByRole("button", {
    name: "Review recorded operation",
    exact: true,
  });
  await expect(recordedOperationAction).toBeVisible();
  await expect(recordedOperationAction).toBeEnabled();
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const previous = await page
      .getByRole("button", { name: "Download original plan JSON", exact: true })
      .boundingBox();
    const recorded = await recordedOperationAction.boundingBox();
    if (!previous || !recorded) throw new Error("Plan review actions are not visible");
    expect(
      recorded.x >= previous.x + previous.width + 4 || recorded.y >= previous.y + previous.height + 4,
    ).toBe(true);
    await page
      .locator("#plans")
      .screenshot({ path: testInfo.outputPath(`plan-operation-action-${label}.png`) });
  }
  await recordedOperationAction.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#operations")).toBeVisible();
  await expect(page.getByLabel("Operation to inspect", { exact: true })).toHaveValue(secondOperation.id);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    secondOperation.id,
  );
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  expect(
    JSON.parse((await page.locator("#operation-list article details pre").textContent()) ?? "null"),
  ).toEqual(exactOperations[0]);
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#operations")
      .screenshot({ path: testInfo.outputPath(`plan-operation-result-${label}.png`) });
  }
  expect(reviewCalls).toHaveLength(handoffCalls);
  expect(await (await page.request.get("/api/v1/snapshot", { headers: readerHeaders })).json()).toEqual(
    beforeHandoff,
  );

  // All previous journey, scope and reciprocal-handoff assertions remain unchanged.
  // The existing Inspect response should be readable without opening technical JSON.
  const stepSnapshot = await (await page.request.get("/api/v1/snapshot", { headers: readerHeaders })).json();
  const stepResponse = await page.request.get(`/api/v1/operations/${secondOperation.id}/events`, {
    headers: readerHeaders,
  });
  expect(stepResponse.ok()).toBe(true);
  const expectedEvents = (await stepResponse.json()) as {
    step: number;
    fence: number;
    outcome: string;
    at: string;
  }[];
  expect(expectedEvents.length).toBeGreaterThan(0);
  expect(expectedEvents.some((event) => event.outcome === "postcondition_verified_in_simulator")).toBe(true);
  expect(expectedEvents.some((event) => event.outcome !== "postcondition_verified_in_simulator")).toBe(true);
  const stepCalls = reviewCalls.length;
  await page.getByRole("button", { name: "Inspect result & step events", exact: true }).click();
  await expect(page.locator("#operation-events")).toHaveText(JSON.stringify(expectedEvents, null, 2));
  const stepHistory = page.getByRole("region", { name: "Recorded step history", exact: true });
  await expect(stepHistory).toBeVisible();
  await expect(stepHistory).toHaveAttribute("data-operation-id", secondOperation.id);
  await expect(stepHistory.locator("li")).toHaveCount(expectedEvents.length);
  for (const [index, event] of expectedEvents.entries()) {
    const row = stepHistory.locator("li").nth(index);
    await expect(row).toHaveAttribute("data-event-index", String(index));
    await expect(row).toHaveAttribute("data-step-index", String(event.step));
    await expect(row).toContainText(`Step ${event.step + 1}`);
    await expect(row).toContainText(`Fence ${event.fence}`);
    await expect(row).toContainText(event.outcome);
    await expect(row).toContainText(event.at);
  }
  await expect(stepHistory).toContainText("not connectivity measurements");
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#operations")
      .screenshot({ path: testInfo.outputPath(`operation-step-history-${label}.png`) });
  }
  expect(reviewCalls.slice(stepCalls).map((url) => new URL(url).pathname)).toEqual([
    `/api/v1/operations/${secondOperation.id}/observation`,
    `/api/v1/operations/${secondOperation.id}/events`,
  ]);
  expect(await (await page.request.get("/api/v1/snapshot", { headers: readerHeaders })).json()).toEqual(
    stepSnapshot,
  );
  expect(
    await (
      await page.request.get(`/api/v1/operations/${secondOperation.id}/events`, { headers: readerHeaders })
    ).json(),
  ).toEqual(expectedEvents);

  // All previous operation-history and nonmutation assertions remain unchanged.
  const originalPlans = stepSnapshot.plans.filter(
    (plan: { id: string }) => plan.id === secondOperation.plan_id,
  );
  expect(originalPlans).toHaveLength(1);
  expect(originalPlans[0]).toEqual(secondSaved);
  expect(originalPlans[0].scope).toBe(secondOperation.scope);
  const requestedActions = stepHistory.locator("[data-requested-action]");
  await expect(requestedActions).toHaveCount(expectedEvents.length);
  for (const [index, event] of expectedEvents.entries()) {
    const originalAction = originalPlans[0].actions[event.step];
    expect(originalAction).toBeDefined();
    const declared = requestedActions.nth(index);
    await expect(declared).toHaveAttribute("data-plan-id", secondOperation.plan_id);
    await expect(declared).toHaveAttribute("data-action-kind", originalAction.kind);
    await expect(declared).toContainText("Requested action from original plan");
    await expect(declared).toContainText(originalAction.target);
  }
  await expect(stepHistory).toContainText("not evidence that this action executed");
  expect(reviewCalls.slice(stepCalls).map((url) => new URL(url).pathname)).toEqual([
    `/api/v1/operations/${secondOperation.id}/observation`,
    `/api/v1/operations/${secondOperation.id}/events`,
  ]);
  expect(await (await page.request.get("/api/v1/snapshot", { headers: readerHeaders })).json()).toEqual(
    stepSnapshot,
  );
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#operations")
      .screenshot({ path: testInfo.outputPath(`requested-action-${label}.png`) });
  }

  // All previous requested-action, event and nonmutation assertions remain unchanged.
  const actionSnapshot = await (
    await page.request.get("/api/v1/snapshot", { headers: readerHeaders })
  ).json();
  expect(actionSnapshot).toEqual(stepSnapshot);
  await page.getByRole("button", { name: "Review original plan", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await page.locator("#plan-selection").selectOption(originalPlans[0].id);
  await expect(page.locator("#plans article")).toHaveAttribute("data-plan-id", originalPlans[0].id);
  const actionCalls = reviewCalls.length;
  const actionDetail = page.getByRole("region", { name: "Requested action detail", exact: true });
  await expect(actionDetail).toBeVisible();
  const nextAction = actionDetail.getByRole("button", { name: "Next proposed action", exact: true });
  for (const [index, action] of originalPlans[0].actions.entries()) {
    await expect(actionDetail).toHaveAttribute("data-plan-id", originalPlans[0].id);
    await expect(actionDetail).toHaveAttribute("data-plan-digest", originalPlans[0].digest);
    await expect(actionDetail).toHaveAttribute("data-action-index", String(index));
    await expect(actionDetail.locator("[data-proposed-kind]")).toHaveAttribute(
      "data-proposed-kind",
      action.kind,
    );
    expect(await actionDetail.locator("[data-proposed-target]").textContent()).toBe(action.target);
    expect(await actionDetail.locator("[data-required-postcondition]").textContent()).toBe(
      action.postcondition,
    );
    expect(
      await actionDetail
        .locator("[data-required-index]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-required-index"))),
    ).toEqual(action.requires.map(String));
    if (index < originalPlans[0].actions.length - 1) {
      await nextAction.focus();
      await nextAction.press("Enter");
    } else await expect(nextAction).toBeDisabled();
  }
  const lastRequired = originalPlans[0].actions.at(-1).requires;
  if (lastRequired.length) {
    await actionDetail.locator("[data-required-index]").first().click();
    await expect(actionDetail).toHaveAttribute("data-action-index", String(lastRequired[0]));
  }
  await expect(actionDetail).toContainText("not evidence of execution");
  await expect(
    page.locator("#plans").getByRole("button", { name: "Apply reviewed plan", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#plans details").first()).not.toHaveAttribute("open", "");
  await page
    .locator("#plans details")
    .first()
    .getByText("Technical plan identifiers & original evidence", { exact: true })
    .click();
  expect(
    JSON.parse((await page.locator("#plans details").first().locator("pre").textContent()) ?? "null"),
  ).toEqual(originalPlans[0]);
  await page
    .locator("#plans details")
    .first()
    .getByText("Technical plan identifiers & original evidence", { exact: true })
    .click();
  expect(reviewCalls.slice(actionCalls)).toEqual([]);
  expect(await (await page.request.get("/api/v1/snapshot", { headers: readerHeaders })).json()).toEqual(
    actionSnapshot,
  );
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await actionDetail.screenshot({ path: testInfo.outputPath(`plan-action-detail-${label}.png`) });
  }

  // All previous focused-action, original-evidence and nonmutation assertions remain unchanged.
  expect(actionSnapshot.plans.length).toBeGreaterThan(1);
  const linkedOriginal = actionSnapshot.plans.at(-1);
  expect(linkedOriginal).toBeDefined();
  expect(linkedOriginal.id).not.toBe(actionSnapshot.plans[0].id);
  await page.locator("#plan-selection").selectOption(linkedOriginal.id);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", linkedOriginal.id);
  const linkBefore = await (await page.request.get("/api/v1/snapshot", { headers: readerHeaders })).json();
  expect(linkBefore).toEqual(actionSnapshot);
  const linkCalls = reviewCalls.length;
  const returnedPlanLink = page.getByRole("link", { name: "Link to this returned plan", exact: true });
  await expect(returnedPlanLink).toBeVisible();
  await expect(returnedPlanLink).toHaveAttribute(
    "href",
    `#/plans?plan=${encodeURIComponent(linkedOriginal.id)}`,
  );
  await returnedPlanLink.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe(`#/plans?plan=${encodeURIComponent(linkedOriginal.id)}`);
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", linkedOriginal.id);
  expect(reviewCalls.slice(linkCalls)).toEqual([]);
  const reloadCalls = reviewCalls.length;
  await page.reload();
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#plans")).toBeVisible();
  await expect(page.locator("#plan-list article")).toHaveAttribute("data-plan-id", linkedOriginal.id);
  await expect(page.locator("#plan-selection")).toHaveValue(linkedOriginal.id);
  await expect(page.getByRole("button", { name: "Apply reviewed plan", exact: true })).toBeDisabled();
  expect(reviewCalls.slice(reloadCalls).map((url) => new URL(url).pathname)).toEqual(["/api/v1/snapshot"]);
  await page.getByText("Technical plan identifiers & original evidence", { exact: true }).click();
  expect(
    JSON.parse((await page.locator("#plans details").first().locator("pre").textContent()) ?? "null"),
  ).toEqual(linkedOriginal);
  await page.getByText("Technical plan identifiers & original evidence", { exact: true }).click();
  expect(await (await page.request.get("/api/v1/snapshot", { headers: readerHeaders })).json()).toEqual(
    linkBefore,
  );
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("#plans").screenshot({ path: testInfo.outputPath(`plan-review-link-${label}.png`) });
  }

  // All previous exact-plan-link, authenticated-reload and nonmutation assertions remain unchanged.
  const operationLinkBefore = await (
    await page.request.get("/api/v1/snapshot", { headers: readerHeaders })
  ).json();
  expect(operationLinkBefore).toEqual(linkBefore);
  expect(operationLinkBefore.operations.length).toBeGreaterThan(1);
  const linkedOperation = operationLinkBefore.operations
    .slice(1)
    .find((operation: { status: string }) => ["succeeded", "partial", "failed"].includes(operation.status));
  expect(linkedOperation).toBeDefined();
  expect(linkedOperation.id).not.toBe(operationLinkBefore.operations[0].id);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Operations", exact: true })
    .click();
  await expect(page.locator("#operations")).toBeVisible();
  await page.locator("#operation-selection").selectOption(linkedOperation.id);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    linkedOperation.id,
  );
  const operationLinkCalls = reviewCalls.length;
  const returnedOperationLink = page.getByRole("link", {
    name: "Link to this returned operation",
    exact: true,
  });
  await expect(returnedOperationLink).toBeVisible();
  await expect(returnedOperationLink).toHaveAttribute(
    "href",
    `#/operations?operation=${encodeURIComponent(linkedOperation.id)}`,
  );
  await returnedOperationLink.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe(`#/operations?operation=${encodeURIComponent(linkedOperation.id)}`);
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    linkedOperation.id,
  );
  expect(reviewCalls.slice(operationLinkCalls)).toEqual([]);
  const operationReloadCalls = reviewCalls.length;
  await page.reload();
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#operations")).toBeVisible();
  await expect(page.locator("#operation-list article")).toHaveAttribute(
    "data-operation-id",
    linkedOperation.id,
  );
  await expect(page.locator("#operation-selection")).toHaveValue(linkedOperation.id);
  await expect(page.getByRole("button", { name: "Simulate external drift", exact: true })).toBeDisabled();
  expect(reviewCalls.slice(operationReloadCalls).map((url) => new URL(url).pathname)).toEqual([
    "/api/v1/snapshot",
  ]);
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  expect(JSON.parse((await page.locator("#operation-list details pre").textContent()) ?? "null")).toEqual(
    linkedOperation,
  );
  await page.getByText("Technical operation identifiers & persisted state", { exact: true }).click();
  const expectedObservation = await (
    await page.request.get(`/api/v1/operations/${linkedOperation.id}/observation`, { headers: readerHeaders })
  ).json();
  const linkedOperationEvents = await (
    await page.request.get(`/api/v1/operations/${linkedOperation.id}/events`, { headers: readerHeaders })
  ).json();
  const explicitInspectCalls = reviewCalls.length;
  const [observedResponse, eventsResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v1/operations/${linkedOperation.id}/observation`,
    ),
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/v1/operations/${linkedOperation.id}/events`,
    ),
    page.getByRole("button", { name: "Inspect result & step events", exact: true }).click(),
  ]);
  expect(await observedResponse.json()).toEqual(expectedObservation);
  expect(await eventsResponse.json()).toEqual(linkedOperationEvents);
  await expect(page.locator("#operation-events")).toHaveText(JSON.stringify(linkedOperationEvents, null, 2));
  expect(reviewCalls.slice(explicitInspectCalls).map((url) => new URL(url).pathname)).toEqual([
    `/api/v1/operations/${linkedOperation.id}/observation`,
    `/api/v1/operations/${linkedOperation.id}/events`,
  ]);
  expect(await (await page.request.get("/api/v1/snapshot", { headers: readerHeaders })).json()).toEqual(
    operationLinkBefore,
  );
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page
      .locator("#operations")
      .screenshot({ path: testInfo.outputPath(`operation-review-link-${label}.png`) });
  }
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

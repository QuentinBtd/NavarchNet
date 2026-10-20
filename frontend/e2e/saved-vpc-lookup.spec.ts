import { expect, test } from "@playwright/test";

// Real current application, HTTP and isolated PostgreSQL observations; no AWS or response mocks.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: reader inspects saved subnet entries, blackholes and reserved destinations", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const beforeResponse = await request.get("/api/v1/snapshot", { headers });
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json();
  expect(before.role).toBe("read_only");
  expect(before.aws_read_only_enabled).toBe(false);
  const account = before.aws_accounts.find((value: { name: string }) => value.name === "Browser saved TGW A");
  expect(account).toBeDefined();
  const path = `/api/v1/aws/accounts/${account.id}/topology`;
  const savedResponse = await request.get(path, { headers });
  expect(savedResponse.status()).toBe(200);
  const savedBefore = await savedResponse.json();
  const apiResponse = await request.get(
    `/api/v1/aws/accounts/${account.id}/vpc-route-lookup?subnet_id=subnet-browser-a&destination=203.0.113.1`,
    { headers },
  );
  expect(apiResponse.status()).toBe(200);
  const apiBody = await apiResponse.json();
  expect(apiBody.result).toMatchObject({
    status: "reported",
    route_table_id: "rtb-browser-a",
    source: "implicit_main",
    lookup: { status: "reported_route", target: { kind: "transit_gateway", id: "tgw-browser-a" } },
  });
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: "Browser saved TGW A" })
    .getByRole("button", { name: "View saved AWS observation" })
    .click();
  const form = page.locator('form[data-vpc-route-lookup="subnet-browser-a"]');
  await expect(form).toHaveCount(1);
  const input = form.getByLabel("Destination IP (saved subnet route lookup)");
  const submit = form.getByRole("button", { name: "Look up saved subnet route" });
  for (const [destination, expected] of [
    ["203.0.113.1", "Reported subnet entry: 203.0.113.1 → 0.0.0.0/0 · transit gateway: tgw-browser-a"],
    ["10.1.2.3", "Reported subnet entry: 10.1.2.3 → 10.1.0.0/16 · VPC local"],
    ["10.2.3.4", "Reported subnet blackhole: 10.2.3.4 → 10.2.0.0/16"],
    ["169.254.169.254", "Unresolved: reserved_service_destination"],
    ["not-an-ip", "Unresolved: invalid_destination"],
  ]) {
    await input.fill(destination);
    const response = page.waitForResponse((value) => value.url().includes("/vpc-route-lookup?"));
    await submit.click();
    const received = await response;
    expect(received.status()).toBe(200);
    const body = await received.json();
    expect(body.topology_id).toBe(savedBefore.topology.id);
    expect(body.subnet_id).toBe("subnet-browser-a");
    expect(body.destination).toBe(destination);
    expect(body.execution_enabled).toBe(false);
    expect(body.connectivity_tested).toBe(false);
    await expect(form.getByRole("status")).toContainText(expected);
    await expect(form.getByRole("status")).toContainText("target health and connectivity remain untested");
    await expect(submit).toBeEnabled();
    await input.fill("203.0.113.250");
    await expect(form.getByRole("status")).not.toContainText("Reported subnet entry");
    await expect(form.getByRole("status")).toContainText("run another saved lookup");
  }
  await expect(page.locator("#aws-topology")).toContainText("Application subnet <img src=x>");
  await expect(page.locator("#aws-topology img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authorize metadata adoption" })).toHaveCount(0);
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: "Browser saved TGW B" })
    .getByRole("button", { name: "View saved AWS observation" })
    .click();
  await expect(page.locator('form[data-vpc-route-lookup="subnet-browser-b"]')).toHaveCount(1);
  await expect(page.locator("#aws-topology")).not.toContainText("Reported subnet entry");
  const afterResponse = await request.get("/api/v1/snapshot", { headers });
  expect(afterResponse.status()).toBe(200);
  expect(await afterResponse.json()).toEqual(before);
  const savedAfterResponse = await request.get(path, { headers });
  expect(savedAfterResponse.status()).toBe(200);
  expect(await savedAfterResponse.json()).toEqual(savedBefore);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
  await expect(page.locator("#workspace")).toBeHidden();
});

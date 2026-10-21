import { expect, test } from "@playwright/test";

// Real production HTTP/static assets and isolated PostgreSQL; no response mocks.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: reader explicitly joins a saved subnet entry to its literal NAT record", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const read = async (path: string) => {
    const response = await request.get(`/api/v1${path}`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const before = await read("/snapshot");
  expect(before.aws_read_only_enabled).toBe(false);
  expect(before.role).toBe("read_only");
  const account = before.aws_accounts.find((row: { name: string }) => row.name === "Browser saved TGW B");
  const other = before.aws_accounts.find((row: { name: string }) => row.name === "Browser saved TGW A");
  expect(account).toBeDefined();
  const path = `/aws/accounts/${account.id}`;
  const saved = await read(`${path}/topology`);
  const query = "subnet_id=subnet-browser-b&destination=203.0.113.1";
  const vpc = await read(`${path}/vpc-route-lookup?${query}`);
  const reference = await read(`${path}/nat-reference-lookup?${query}`);
  expect(reference.account_id).toBe(account.id);
  expect(reference.topology_id).toBe(saved.topology.id);
  expect(reference.completed_at).toBe(saved.topology.completed_at);
  expect(reference.reference_only).toBe(true);
  expect(reference.execution_enabled).toBe(false);
  expect(reference.connectivity_tested).toBe(false);
  expect(reference.result.subnet_lookup).toEqual(vpc.result);
  const raw = saved.topology.resources.find((row: { id: string }) => row.id === "nat-browser-regional");
  expect(reference.result.reference.resource).toEqual(raw);
  expect(reference.result.reference.owner_scope).toBe("reported_same");
  expect(reference.result.reference.vpc_scope).toBe("not_reported");
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/nat-reference-lookup")) calls.push(request.url());
  });
  await page.goto("/#/aws");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const open = async (name: string) =>
    page
      .locator("#aws-account-list li")
      .filter({ hasText: name })
      .getByRole("button", { name: "View saved AWS observation" })
      .click();
  await open(account.name);
  const form = page.locator('form[data-vpc-route-lookup="subnet-browser-b"]');
  const input = form.getByLabel("Destination IP (saved subnet route lookup)");
  const submit = form.getByRole("button", { name: "Look up saved subnet route", exact: true });
  await input.fill("203.0.113.1");
  await submit.click();
  await expect(form.locator(':scope > [role="status"]')).toContainText("NAT gateway: nat-browser-regional");
  const panel = form.locator("fieldset[data-nat-reference]");
  await expect(panel).toHaveCount(1);
  expect(calls).toHaveLength(0);
  const action = panel.getByRole("button", { name: "Inspect referenced saved NAT record", exact: true });
  await expect(action).toHaveAttribute("type", "button");
  await action.click();
  await expect(panel).toContainText("Referenced saved NAT record: nat-browser-regional");
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0] ?? "").pathname).toBe(`/api/v1${path}/nat-reference-lookup`);
  expect([...new URL(calls[0] ?? "").searchParams.entries()]).toEqual([
    ["subnet_id", "subnet-browser-b"],
    ["destination", "203.0.113.1"],
  ]);
  for (const value of [
    account.id,
    saved.topology.id,
    saved.topology.completed_at,
    "subnet-browser-b",
    "203.0.113.1",
    "reported_same",
    "not_reported",
    "not ownership, authority or routing validation",
  ])
    await expect(panel).toContainText(value);
  const detail = panel.locator("details[data-nat-metadata]");
  await expect(detail.locator("[data-nat-address]")).toHaveCount(0);
  await detail.getByText("Inspect reported NAT metadata", { exact: true }).click();
  const addresses = detail.locator("[data-nat-address]");
  await expect(addresses).toHaveCount(3);
  await expect(addresses.nth(1)).toContainText("Reported status: failed");
  await expect(addresses.nth(2)).toContainText("future-<img src=x>");
  await expect(addresses.nth(2)).toContainText("AZ ID: not reported");
  await expect(addresses.nth(2)).toContainText("Reported primary: not reported");
  await expect(detail).toContainText("nat-literal-unvalidated-table-reference");
  await expect(detail).toContainText("not selected egress IPs");
  await expect(panel.locator("img, a, form, input, select, [data-aws-write]")).toHaveCount(0);
  expect(await form.evaluate((node: HTMLFormElement) => node.checkValidity())).toBe(true);
  expect(calls).toHaveLength(1);
  await submit.click();
  await expect(form.locator(':scope > [role="status"]')).toContainText("NAT gateway: nat-browser-regional");
  await expect(panel.locator("details[data-nat-metadata]")).toHaveCount(0);
  expect(calls).toHaveLength(1);
  await input.fill("203.0.113.2");
  await expect(panel).toHaveCount(0);
  for (const destination of ["10.1.2.3", "198.51.100.7", "169.254.169.254", "not-an-ip"]) {
    await input.fill(destination);
    await submit.click();
    await expect(form.locator(':scope > [role="status"]')).not.toContainText("Reading saved");
    await expect(panel).toHaveCount(0);
  }
  await input.fill("203.0.113.1");
  await submit.click();
  await expect(panel).toHaveCount(1);
  await open(other.name);
  await expect(page.locator("fieldset[data-nat-reference]")).toHaveCount(0);
  await open(account.name);
  await expect(page.locator('form[data-vpc-route-lookup="subnet-browser-b"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
  expect(calls).toHaveLength(1);
  expect(await read(`${path}/topology`)).toEqual(saved);
  expect(await read("/snapshot")).toEqual(before);
});

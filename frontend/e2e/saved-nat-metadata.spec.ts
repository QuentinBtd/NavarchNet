import { expect, test } from "@playwright/test";

// Actual current production server/static UI and isolated PostgreSQL; no response mocks.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: reader inspects literal saved NAT address tuples without selecting egress", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const snapshot = async () => {
    const response = await request.get("/api/v1/snapshot", { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const before = await snapshot();
  expect(before.aws_read_only_enabled).toBe(false);
  expect(before.role).toBe("read_only");
  const network = before.aws_accounts.find((row: { name: string }) => row.name === "Browser saved TGW B");
  const other = before.aws_accounts.find((row: { name: string }) => row.name === "Browser saved TGW A");
  expect(network).toBeDefined();
  expect(other).toBeDefined();
  const saved = async () => {
    const response = await request.get(`/api/v1/aws/accounts/${network.id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const savedBefore = await saved();
  const nat = savedBefore.topology.resources.find((row: { id: string }) => row.id === "nat-browser-regional");
  expect(nat.nat_gateway.route_table_id).toBe("nat-literal-unvalidated-table-reference");
  expect(nat.nat_gateway.addresses).toHaveLength(3);
  expect(nat.nat_gateway.addresses.map((row: { status: string }) => row.status)).toEqual([
    "succeeded",
    "failed",
    "future-<img src=x>",
  ]);
  expect(nat.nat_gateway.addresses[2].az_id).toBeNull();
  expect(nat.nat_gateway.addresses[2].is_primary).toBeNull();
  expect(nat.subnet_id).toBeNull();
  expect(savedBefore.topology.execution_enabled).toBe(false);
  expect(savedBefore.topology.connectivity_tested).toBe(false);
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const open = async (name: string) => {
    await page
      .locator("#aws-account-list li")
      .filter({ hasText: name })
      .getByRole("button", { name: "View saved AWS observation" })
      .click();
  };
  await open(network.name);
  const card = (id: string) =>
    page
      .locator("#aws-topology article")
      .filter({ has: page.getByRole("heading", { name: `nat_gateway · ${id}`, exact: true }) });
  const detail = card(nat.id).locator("details[data-nat-metadata]");
  await expect(detail).toHaveCount(1);
  await detail.getByText("Inspect reported NAT metadata", { exact: true }).click();
  const addresses = detail.getByRole("list", { name: "Reported NAT address tuples" }).getByRole("listitem");
  await expect(addresses).toHaveCount(3);
  for (const [index, ip] of ["203.0.113.10", "203.0.113.20", "203.0.113.30"].entries())
    await expect(addresses.nth(index)).toContainText(ip);
  await expect(addresses.nth(0)).toContainText("AZ ID: euw1-az1");
  await expect(addresses.nth(0)).toContainText("Reported primary: true");
  await expect(addresses.nth(1)).toContainText("Reported status: failed");
  await expect(addresses.nth(1)).toContainText("Reported primary: false");
  await expect(addresses.nth(2)).toContainText("Reported status: future-<img src=x>");
  await expect(addresses.nth(2)).toContainText("AZ ID: not reported");
  await expect(addresses.nth(2)).toContainText("Reported primary: not reported");
  for (const value of [
    savedBefore.topology.id,
    savedBefore.topology.completed_at,
    "nat-literal-unvalidated-table-reference",
    "Unvalidated routeTableId reference",
    "not selected egress IPs",
    "not NAT health or a selected traffic AZ",
  ])
    await expect(detail).toContainText(value);
  for (const [id, expected] of [
    ["nat-browser-legacy", "NAT details not captured in this observation"],
    ["nat-browser-unreported", "Address collection not reported"],
    ["nat-browser-empty", "Reported address tuples: 0"],
  ]) {
    const current = card(id).locator("details[data-nat-metadata]");
    await current.getByText("Inspect reported NAT metadata", { exact: true }).click();
    await expect(current).toContainText(expected);
    await expect(current).toContainText("Availability mode: not reported");
  }
  await expect(page.locator("#aws-topology img")).toHaveCount(0);
  await expect(detail.locator("a, form, input, select")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authorize metadata adoption" })).toHaveCount(0);
  await open(other.name);
  await expect(page.locator("details[data-nat-metadata]")).toHaveCount(0);
  expect(await saved()).toEqual(savedBefore);
  expect(await snapshot()).toEqual(before);
  await open(network.name);
  await expect(card(nat.id).locator("details[data-nat-metadata]")).toHaveCount(1);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
});

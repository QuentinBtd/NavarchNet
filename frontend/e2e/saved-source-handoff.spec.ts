import { expect, test } from "@playwright/test";

// Actual production application/HTTP and synthetic isolated PostgreSQL; no API response mocks.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: reader binds saved source and network observations to an ingress candidate", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const snapshotResponse = await request.get("/api/v1/snapshot", { headers });
  expect(snapshotResponse.status()).toBe(200);
  const before = await snapshotResponse.json();
  expect(before.aws_read_only_enabled).toBe(false);
  expect(before.role).toBe("read_only");
  const source = before.aws_accounts.find((value: { name: string }) => value.name === "Browser saved TGW A");
  const network = before.aws_accounts.find((value: { name: string }) => value.name === "Browser saved TGW B");
  expect(source).toBeDefined();
  expect(network).toBeDefined();
  const saved = async (id: string) => {
    const response = await request.get(`/api/v1/aws/accounts/${id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const sourceBefore = await saved(source.id);
  const networkBefore = await saved(network.id);
  expect(sourceBefore.topology.completed_at).not.toBe(networkBefore.topology.completed_at);
  // Positive two-AZ dual-stack metadata case, not IPv6 forwarding or live AWS acceptance.
  for (const id of ["subnet-browser-attachment-1", "subnet-browser-attachment-2"]) {
    const subnet = sourceBefore.topology.resources.find((row: { id: string }) => row.id === id);
    expect(subnet.cidrs.some((cidr: string) => cidr.includes(":"))).toBe(true);
    expect(subnet.cidrs.some((cidr: string) => cidr.includes("."))).toBe(true);
  }
  const parameters = new URLSearchParams({
    network_account_id: network.id,
    subnet_id: "subnet-browser-source",
    destination: "203.0.113.1",
  });
  const apiResponse = await request.get(`/api/v1/aws/accounts/${source.id}/tgw-source-lookup?${parameters}`, {
    headers,
  });
  expect(apiResponse.status()).toBe(200);
  expect((await apiResponse.json()).result.handoff).toMatchObject({
    status: "reported_candidate",
    transit_gateway_id: "tgw-browser-b",
    ingress_attachment_id: "tgw-attach-browser-source",
    attachment_subnet_id: "subnet-browser-attachment-1",
    az_id: "euw1-az1",
    route_table_id: "tgw-rtb-browser-b",
    lookup: { status: "reported_forward" },
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
  const row = page
    .locator("#aws-topology article")
    .filter({ has: page.getByRole("heading", { name: "subnet · subnet-browser-source", exact: true }) });
  await row.getByText("Inspect saved source-to-TGW candidate", { exact: true }).click();
  const form = row.locator('form[data-source-handoff="subnet-browser-source"]');
  await expect(form).toHaveCount(1);
  const account = form.getByLabel("Network account / region (saved observation)");
  const destination = form.getByLabel("Destination IP (source-to-TGW candidate)");
  const submit = form.getByRole("button", { name: "Inspect saved ingress candidate" });
  await account.selectOption(network.id);
  for (const [ip, expected] of [
    ["203.0.113.1", "Reported ingress candidate"],
    ["10.2.3.4", "Reported TGW blackhole"],
    ["10.10.2.3", "source_route_not_transit_gateway"],
    ["not-an-ip", "invalid_destination"],
  ]) {
    await destination.fill(ip);
    const pending = page.waitForResponse((value) => value.url().includes("/tgw-source-lookup?"));
    await submit.click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const value = await response.json();
    expect(value.source_topology_id).toBe(sourceBefore.topology.id);
    expect(value.network_topology_id).toBe(networkBefore.topology.id);
    expect(value.network_account_id).toBe(network.id);
    expect(value.execution_enabled).toBe(false);
    expect(value.connectivity_tested).toBe(false);
    await expect(form.getByRole("status")).toContainText(expected);
    await expect(form.getByRole("status")).toContainText(sourceBefore.topology.id);
    await expect(form.getByRole("status")).toContainText(networkBefore.topology.id);
    await expect(form.getByRole("status")).toContainText("Independent saved observations");
    await expect(form.getByRole("status")).toContainText("not a validated path");
    await expect(submit).toBeEnabled();
  }
  await account.selectOption(source.id);
  await expect(form.getByRole("status")).not.toContainText(networkBefore.topology.id);
  await destination.fill("203.0.113.1");
  await submit.click();
  await expect(form.getByRole("status")).toContainText("missing_or_ambiguous_attachment");
  await expect(page.locator("#aws-topology img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authorize metadata adoption" })).toHaveCount(0);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(before);
  expect(await saved(source.id)).toEqual(sourceBefore);
  expect(await saved(network.id)).toEqual(networkBefore);
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: "Browser saved TGW B" })
    .getByRole("button", { name: "View saved AWS observation" })
    .click();
  await expect(page.locator("#aws-topology")).not.toContainText("Reported ingress candidate");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
  await expect(page.locator("#workspace")).toBeHidden();
});

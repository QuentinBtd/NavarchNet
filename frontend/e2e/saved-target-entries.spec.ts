import { expect, test } from "@playwright/test";

// Real current production server, static UI and synthetic isolated PostgreSQL. No API mocks.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: reader explicitly follows a reported attachment into same-snapshot target subnet entries", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const response = await request.get("/api/v1/snapshot", { headers });
  expect(response.status()).toBe(200);
  const before = await response.json();
  expect(before.aws_read_only_enabled).toBe(false);
  expect(before.role).toBe("read_only");
  const source = before.aws_accounts.find((row: { name: string }) => row.name === "Browser saved TGW A");
  const network = before.aws_accounts.find((row: { name: string }) => row.name === "Browser saved TGW B");
  expect(source).toBeDefined();
  expect(network).toBeDefined();
  const saved = async (id: string) => {
    const response = await request.get(`/api/v1/aws/accounts/${id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const sourceBefore = await saved(source.id),
    networkBefore = await saved(network.id);
  const parameters = new URLSearchParams({
    transit_gateway_id: "tgw-browser-b",
    target_attachment_id: "tgw-attach-browser-egress-b",
    destination: "203.0.113.1",
  });
  const direct = await request.get(`/api/v1/aws/accounts/${network.id}/tgw-target-lookup?${parameters}`, {
    headers,
  });
  expect(direct.status()).toBe(200);
  const metadata = await direct.json();
  expect(metadata.topology_id).toBe(networkBefore.topology.id);
  expect(metadata.az_selection).toBe("not_inferred");
  expect(metadata.result.status).toBe("reported_subnets");
  expect(metadata.result.subnets).toHaveLength(2);
  expect(metadata.result.subnets.map((entry: { az_id: string }) => entry.az_id)).toEqual([
    "euw1-az1",
    "euw1-az2",
  ]);
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
  const destination = form.getByLabel("Destination IP (source-to-TGW candidate)");
  await form.getByLabel("Network account / region (saved observation)").selectOption(network.id);
  for (const [ip, expected] of [
    ["203.0.113.1", "nat_gateway nat-browser-regional"],
    ["198.51.100.7", "Reported target blackhole"],
  ]) {
    await destination.fill(ip);
    await form.getByRole("button", { name: "Inspect saved ingress candidate" }).click();
    await expect(form.locator(":scope > [role=status]")).toContainText("Reported ingress candidate");
    const target = form.locator("fieldset[data-target-entries]");
    await expect(target).toHaveCount(1);
    const select = target.getByLabel("Reported TGW target attachment");
    expect(await select.inputValue()).toBe("");
    await select.selectOption("tgw-attach-browser-egress-b");
    const pending = page.waitForResponse((value) => value.url().includes("/tgw-target-lookup?"));
    await target.getByRole("button", { name: "Inspect all saved target subnet entries" }).click();
    const received = await pending;
    expect(received.status()).toBe(200);
    const body = await received.json();
    expect(body.topology_id).toBe(networkBefore.topology.id);
    expect(body.completed_at).toBe(networkBefore.topology.completed_at);
    expect(body.destination).toBe(ip);
    expect(body.az_selection).toBe("not_inferred");
    expect(body.execution_enabled).toBe(false);
    expect(body.connectivity_tested).toBe(false);
    const output = target.getByRole("status");
    await expect(output).toContainText(expected);
    for (const text of [
      "subnet-browser-b",
      "subnet-browser-target-2",
      "euw1-az1",
      "euw1-az2",
      networkBefore.topology.id,
      "traffic AZ is not inferred",
      "connectivity remain untested",
    ])
      await expect(output).toContainText(text);
    await expect(target.locator("form")).toHaveCount(0);
    await destination.fill("203.0.113.8");
    await expect(form.locator("fieldset[data-target-entries]")).toHaveCount(0);
  }
  expect(await saved(source.id)).toEqual(sourceBefore);
  expect(await saved(network.id)).toEqual(networkBefore);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(before);
  await expect(page.locator("#aws-topology img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authorize metadata adoption" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
});

import { expect, test } from "@playwright/test";

// Real current production HTTP/static UI and isolated PostgreSQL, no response mocks.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: source A explicitly inspects every target subnet NAT reference in network B", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const read = async (path: string) => {
    const result = await request.get(`/api/v1${path}`, { headers });
    expect(result.status()).toBe(200);
    return result.json();
  };
  const before = await read("/snapshot");
  expect(before.aws_read_only_enabled).toBe(false);
  expect(before.role).toBe("read_only");
  const source = before.aws_accounts.find((row: { name: string }) => row.name === "Browser saved TGW A");
  const network = before.aws_accounts.find((row: { name: string }) => row.name === "Browser saved TGW B");
  expect(source.id).not.toBe(network.id);
  expect(source.aws_account_id).not.toBe(network.aws_account_id);
  const savedA = await read(`/aws/accounts/${source.id}/topology`);
  const savedB = await read(`/aws/accounts/${network.id}/topology`);
  expect(savedA.topology.completed_at).toBe("2");
  expect(savedB.topology.completed_at).toBe("4");
  const targetQuery = new URLSearchParams({
    transit_gateway_id: "tgw-browser-b",
    target_attachment_id: "tgw-attach-browser-egress-b",
    destination: "203.0.113.1",
  });
  const targetData = await read(`/aws/accounts/${network.id}/tgw-target-lookup?${targetQuery}`);
  expect(targetData.result.subnets).toHaveLength(2);
  const raw = savedB.topology.resources.find((row: { id: string }) => row.id === "nat-browser-regional");
  for (const row of targetData.result.subnets) {
    const parameters = new URLSearchParams({ subnet_id: row.subnet_id, destination: "203.0.113.1" });
    const nat = await read(`/aws/accounts/${network.id}/nat-reference-lookup?${parameters}`);
    expect(nat.account_id).toBe(network.id);
    expect(nat.topology_id).toBe(savedB.topology.id);
    expect(nat.completed_at).toBe("4");
    expect(nat.reference_only).toBe(true);
    expect(nat.execution_enabled).toBe(false);
    expect(nat.connectivity_tested).toBe(false);
    expect(nat.result.subnet_lookup).toEqual(row.lookup);
    expect(nat.result.reference.resource).toEqual(raw);
  }
  const calls: string[] = [];
  page.on("request", (value) => {
    if (value.url().includes("/nat-reference-lookup")) calls.push(value.url());
  });
  await page.goto("/#/aws");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: source.name })
    .getByRole("button", { name: "View saved AWS observation" })
    .click();
  const card = page
    .locator("#aws-topology article")
    .filter({ has: page.getByRole("heading", { name: "subnet · subnet-browser-source", exact: true }) });
  await card.getByText("Inspect saved source-to-TGW candidate", { exact: true }).click();
  const form = card.locator('form[data-source-handoff="subnet-browser-source"]');
  const destination = form.getByLabel("Destination IP (source-to-TGW candidate)");
  await form.getByLabel("Network account / region (saved observation)").selectOption(network.id);
  await destination.fill("203.0.113.1");
  const sourceRead = form.getByRole("button", { name: "Inspect saved ingress candidate", exact: true });
  const target = form.locator("fieldset[data-target-entries]");
  const targetRead = target.getByRole("button", {
    name: "Inspect all saved target subnet entries",
    exact: true,
  });
  const runTarget = async () => {
    await sourceRead.click();
    await expect(form.locator(':scope > [role="status"]')).toContainText("Reported ingress candidate");
    expect(await form.evaluate((node: HTMLFormElement) => node.checkValidity())).toBe(true);
    await target.getByLabel("Reported TGW target attachment").selectOption("tgw-attach-browser-egress-b");
    await targetRead.click();
    await expect(target.locator(':scope > [role="status"]')).toContainText("subnet-browser-target-2");
  };
  await runTarget();
  const children = target.locator("fieldset[data-nat-reference]");
  await expect(children).toHaveCount(2);
  expect(calls).toHaveLength(0);
  for (const [index, subnet] of ["subnet-browser-b", "subnet-browser-target-2"].entries()) {
    const row = target.locator(`[data-target-nat-subnet="${subnet}"]`);
    const child = row.locator("fieldset[data-nat-reference]");
    await expect(child).toHaveCount(1);
    const reply = page.waitForResponse((value) => value.url().includes("/nat-reference-lookup?"));
    await child.getByRole("button", { name: "Inspect referenced saved NAT record", exact: true }).click();
    const response = await reply;
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.account_id).toBe(network.id);
    expect(body.result.subnet_lookup).toEqual(targetData.result.subnets[index].lookup);
    await expect(child).toContainText("Referenced saved NAT record: nat-browser-regional");
    for (const text of [
      network.id,
      savedB.topology.id,
      "completed: 4",
      subnet,
      "reported_same",
      "not_reported",
      "not ownership, authority or routing validation",
    ])
      await expect(child).toContainText(text);
    const detail = child.locator("details[data-nat-metadata]");
    await expect(detail.locator("[data-nat-address]")).toHaveCount(0);
    await detail.getByText("Inspect reported NAT metadata", { exact: true }).click();
    const addresses = detail.locator("[data-nat-address]");
    await expect(addresses).toHaveCount(3);
    await expect(addresses.nth(0)).toContainText("Reported status: succeeded");
    await expect(addresses.nth(1)).toContainText("Reported status: failed");
    await expect(addresses.nth(2)).toContainText("future-<img src=x>");
    await expect(addresses.nth(2)).toContainText("Reported primary: not reported");
    await expect(detail).toContainText("Unvalidated routeTableId reference");
    await expect(detail).toContainText("not selected egress IPs");
    expect(calls).toHaveLength(index + 1);
    const url = new URL(calls[index] ?? "");
    expect(url.pathname).toBe(`/api/v1/aws/accounts/${network.id}/nat-reference-lookup`);
    expect([...url.searchParams.entries()]).toEqual([
      ["subnet_id", subnet],
      ["destination", "203.0.113.1"],
    ]);
    await expect(page.locator("#aws-topology h3")).toContainText(source.aws_account_id);
  }
  await expect(target.locator("img, a, form, input, [data-aws-write]")).toHaveCount(0);
  expect(await form.evaluate((node: HTMLFormElement) => node.checkValidity())).toBe(true);
  await targetRead.click();
  await expect(children).toHaveCount(2);
  await expect(target.locator("details[data-nat-metadata]")).toHaveCount(0);
  expect(calls).toHaveLength(2);
  await sourceRead.click();
  await expect(form.locator(':scope > [role="status"]')).toContainText("Reported ingress candidate");
  await expect(children).toHaveCount(0);
  await destination.fill("198.51.100.7");
  await runTarget();
  await expect(target.locator(':scope > [role="status"]')).toContainText("Reported target blackhole");
  await expect(children).toHaveCount(0);
  expect(calls).toHaveLength(2);
  expect(await read(`/aws/accounts/${source.id}/topology`)).toEqual(savedA);
  expect(await read(`/aws/accounts/${network.id}/topology`)).toEqual(savedB);
  expect(await read("/snapshot")).toEqual(before);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
});

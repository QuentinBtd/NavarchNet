import { expect, test } from "@playwright/test";

// Real current server/static UI and isolated PostgreSQL, synthetic metadata, SDK off; no response mocks.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: reader independently inspects a source attachment-subnet table for an operator IP", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const beforeResponse = await request.get("/api/v1/snapshot", { headers });
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json();
  expect(before.aws_read_only_enabled).toBe(false);
  expect(before.role).toBe("read_only");
  const source = before.aws_accounts.find(
    (account: { name: string }) => account.name === "Browser saved TGW A",
  );
  const network = before.aws_accounts.find(
    (account: { name: string }) => account.name === "Browser saved TGW B",
  );
  expect(source).toBeDefined();
  expect(network).toBeDefined();
  const saved = async (id: string) => {
    const response = await request.get(`/api/v1/aws/accounts/${id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const sourceBefore = await saved(source.id),
    networkBefore = await saved(network.id);
  expect(sourceBefore.topology.completed_at).not.toBe(networkBefore.topology.completed_at);
  const candidateSubnet = "subnet-browser-attachment-1";
  expect(
    sourceBefore.subnet_route_tables.find((row: { subnet_id: string }) => row.subnet_id === candidateSubnet)
      .selection,
  ).toEqual({
    status: "selected",
    route_table_id: "rtb-browser-source-attachment",
    source: "explicit_subnet",
  });
  const parentQuery = new URLSearchParams({
    network_account_id: network.id,
    subnet_id: "subnet-browser-source",
    destination: "203.0.113.1",
  });
  const parentResponse = await request.get(
    `/api/v1/aws/accounts/${source.id}/tgw-source-lookup?${parentQuery}`,
    { headers },
  );
  expect(parentResponse.status()).toBe(200);
  const parentBody = await parentResponse.json();
  expect(parentBody.result.handoff.attachment_subnet_id).toBe(candidateSubnet);
  expect(parentBody.source_topology_id).toBe(sourceBefore.topology.id);
  expect(parentBody.network_topology_id).toBe(networkBefore.topology.id);
  const queries: string[] = [],
    parentQueries: string[] = [];
  page.on("request", (event) => {
    if (event.url().includes("/vpc-route-lookup?")) queries.push(event.url());
    if (event.url().includes("/tgw-source-lookup?")) parentQueries.push(event.url());
  });
  await page.goto("/#/aws");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const accountRow = (name: string) => page.locator("#aws-account-list li").filter({ hasText: name });
  await accountRow("Browser saved TGW A").getByRole("button", { name: "View saved AWS observation" }).click();
  const row = page
    .locator("#aws-topology article")
    .filter({ has: page.getByRole("heading", { name: "subnet · subnet-browser-source", exact: true }) });
  await row.getByText("Inspect saved source-to-TGW candidate", { exact: true }).click();
  const form = row.locator('form[data-source-handoff="subnet-browser-source"]');
  const original = form.getByLabel("Destination IP (source-to-TGW candidate)");
  await form.getByLabel("Network account / region (saved observation)").selectOption(network.id);
  await original.fill("203.0.113.1");
  const parentAction = form.getByRole("button", { name: "Inspect saved ingress candidate", exact: true });
  await parentAction.click();
  const child = form.locator("fieldset[data-source-attachment-entry]");
  await expect(child).toHaveCount(1);
  const point = child.getByLabel("Operator-supplied destination IP (separate point inspection)");
  const action = child.getByRole("button", {
    name: "Inspect saved source attachment-subnet entry",
    exact: true,
  });
  const status = child.locator(":scope > [role=status]");
  await expect(point).toHaveValue("");
  expect(parentQueries).toHaveLength(1);
  expect(await form.evaluate((element: HTMLFormElement) => element.checkValidity())).toBe(true);
  expect(queries).toHaveLength(0);
  await action.click();
  await expect(status).toContainText("Enter one destination IP");
  expect(queries).toHaveLength(0);
  await point.press("Enter");
  await expect(child).toHaveCount(1);
  expect(queries).toHaveLength(0);
  expect(parentQueries).toHaveLength(1);
  for (const [ip, expected, wireStatus] of [
    ["10.10.254.10", "Reported attachment-subnet entry", "reported_route"],
    ["10.10.1.10", "Reported attachment-subnet blackhole", "reported_blackhole"],
    ["not-an-ip", "invalid_destination", "unresolved"],
  ]) {
    await point.fill(ip);
    const pending = page.waitForResponse((event) => event.url().includes("/vpc-route-lookup?"));
    await action.click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const body = await response.json(),
      url = new URL(response.url());
    expect(url.pathname).toBe(`/api/v1/aws/accounts/${source.id}/vpc-route-lookup`);
    expect(url.searchParams.get("subnet_id")).toBe(candidateSubnet);
    expect(url.searchParams.get("destination")).toBe(ip);
    expect([...url.searchParams.keys()].sort()).toEqual(["destination", "subnet_id"]);
    expect(body.topology_id).toBe(sourceBefore.topology.id);
    expect(body.execution_enabled).toBe(false);
    expect(body.connectivity_tested).toBe(false);
    expect(body.result.route_table_id).toBe("rtb-browser-source-attachment");
    expect(body.result.source).toBe("explicit_subnet");
    expect(body.result.lookup.status).toBe(wireStatus);
    expect(body).not.toHaveProperty("completed_at");
    expect(body).not.toHaveProperty("account_id");
    await expect(status).toContainText(expected);
    await expect(child).toContainText("not a validated return path");
    await expect(child).toContainText("operator-supplied");
    await expect(child).toContainText(`completed ${sourceBefore.topology.completed_at}`);
    await expect(child).toContainText("203.0.113.1");
    await expect(form.locator(":scope > [role=status]")).toContainText(
      `completed ${networkBefore.topology.completed_at}`,
    );
    await expect(parentAction).toBeEnabled();
  }
  expect(queries).toHaveLength(3);
  await point.fill("10.10.254.10");
  await action.click();
  await expect(status).toContainText("Reported attachment-subnet entry");
  // Identical source resubmit retires the completed dependent result, not merely changed values.
  await parentAction.click();
  await expect(child).toHaveCount(1);
  await expect(child.getByLabel("Operator-supplied destination IP (separate point inspection)")).toHaveValue(
    "",
  );
  await expect(child.locator(":scope > [role=status]")).not.toContainText("Reported attachment-subnet entry");
  expect(queries).toHaveLength(4);
  await expect(form.locator("form")).toHaveCount(0);
  await expect(child.locator("a,img,fieldset[data-nat-reference]")).toHaveCount(0);
  expect(await form.evaluate((element: HTMLFormElement) => element.checkValidity())).toBe(true);
  await expect(page.getByRole("button", { name: "Authorize metadata adoption" })).toHaveCount(0);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(before);
  expect(await saved(source.id)).toEqual(sourceBefore);
  expect(await saved(network.id)).toEqual(networkBefore);
  await accountRow("Browser saved TGW B").getByRole("button", { name: "View saved AWS observation" }).click();
  await expect(page.locator("#aws-topology fieldset[data-source-attachment-entry]")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
});

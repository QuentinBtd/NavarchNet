import { expect, test } from "@playwright/test";

// Real production HTTP/static UI and isolated PostgreSQL; synthetic saved observations, SDK off.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: reader explicitly inspects independent saved source-to-TGW CIDR decisions", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const snapshot = await request.get("/api/v1/snapshot", { headers });
  expect(snapshot.status()).toBe(200);
  const before = await snapshot.json();
  expect(before.aws_read_only_enabled).toBe(false);
  const source = before.aws_accounts.find((a: { name: string }) => a.name === "Browser saved TGW A");
  const network = before.aws_accounts.find((a: { name: string }) => a.name === "Browser saved TGW B");
  expect(source).toBeDefined();
  expect(network).toBeDefined();
  const saved = async (id: string) => {
    const response = await request.get(`/api/v1/aws/accounts/${id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const sourceBefore = await saved(source.id);
  const networkBefore = await saved(network.id);
  const query = {
    network_account_id: network.id,
    subnet_id: "subnet-browser-source",
    destination_cidr: "203.0.113.0/29",
  };
  const path = `/api/v1/aws/accounts/${source.id}/tgw-source-cidr-coverage?${new URLSearchParams(query)}`;
  const response = await request.get(path, { headers });
  expect(response.status()).toBe(200);
  const oracle = await response.json();
  expect(oracle.query).toEqual({ source_account_id: source.id, ...query });
  expect(oracle).toMatchObject({
    reference_only: true,
    partition_complete: true,
    execution_enabled: false,
    connectivity_tested: false,
    simultaneous_snapshots: false,
  });
  expect(oracle.source_saved.saved_row_id).toBe(sourceBefore.topology.id);
  expect(oracle.network_saved.saved_row_id).toBe(networkBefore.topology.id);
  expect(oracle.source_saved.registration.id).toBe(source.id);
  expect(oracle.network_saved.registration.id).toBe(network.id);
  expect(oracle.source_saved.generation).toBeGreaterThan(0);
  expect(oracle.network_saved.generation).toBeGreaterThan(0);
  expect(oracle.source_saved.topology.completed_at).not.toBe(oracle.network_saved.topology.completed_at);
  expect(oracle.segments.length).toBeGreaterThan(0);
  expect(oracle.origins.length).toBeGreaterThan(0);
  // Establish working backend/PG before the deliberately missing UI control assertion.
  expect(await saved(source.id)).toEqual(sourceBefore);
  expect(await saved(network.id)).toEqual(networkBefore);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(before);

  await page.goto("/#/aws");
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
  const parent = row.locator('form[data-source-handoff="subnet-browser-source"]');
  await parent.getByLabel("Network account / region (saved observation)").selectOption(network.id);
  const sibling = row.locator('details[data-source-cidr="subnet-browser-source"]');
  await expect(row.getByText("Inspect saved source-to-TGW CIDR decisions", { exact: true })).toHaveCount(1);
  await expect(sibling).not.toHaveAttribute("open");
  await expect(sibling.locator("input")).toHaveCount(0);
  let cidrRequests = 0;
  let pointRequests = 0;
  page.on("request", (value) => {
    if (value.url().includes("/tgw-source-cidr-coverage?")) cidrRequests++;
    if (value.url().includes("/tgw-source-lookup?")) pointRequests++;
  });
  await sibling.getByText("Inspect saved source-to-TGW CIDR decisions", { exact: true }).click();
  const cidr = sibling.getByLabel("Destination CIDR (source-to-TGW decisions)");
  const inspect = sibling.getByRole("button", { name: "Inspect saved CIDR decisions", exact: true });
  await expect(cidr).toHaveValue("");
  expect(cidrRequests).toBe(0);
  await expect(parent.getByLabel("Destination IP (source-to-TGW candidate)")).toHaveValue("");
  await cidr.fill(query.destination_cidr);
  const pending = page.waitForResponse((value) => value.url().includes("/tgw-source-cidr-coverage?"));
  await inspect.click();
  const accepted = await pending;
  expect(accepted.status()).toBe(200);
  expect(new URL(accepted.url()).pathname).toBe(`/api/v1/aws/accounts/${source.id}/tgw-source-cidr-coverage`);
  expect(Object.fromEntries(new URL(accepted.url()).searchParams)).toEqual(query);
  expect(await accepted.json()).toEqual(oracle);
  const summary = sibling.locator("[data-source-cidr-summary]");
  await expect(summary).toContainText(sourceBefore.topology.id);
  await expect(summary).toContainText(networkBefore.topology.id);
  await expect(summary).toContainText("not a validated path");
  await expect(sibling.locator("[data-source-cidr-interval]")).toHaveCount(0);
  await sibling.locator("details[data-source-cidr-intervals] > summary").click();
  await expect(sibling.locator("[data-source-cidr-interval]")).toHaveCount(oracle.segments.length);
  for (let i = 0; i < oracle.segments.length; i++) {
    const item = sibling.locator("[data-source-cidr-interval]").nth(i);
    await expect(item).toContainText(oracle.segments[i].start);
    await expect(item).toContainText(oracle.segments[i].end_inclusive);
  }
  expect(cidrRequests).toBe(1);
  expect(pointRequests).toBe(0);
  await cidr.fill("");
  await expect(summary).toHaveCount(0);
  const point = parent.getByLabel("Destination IP (source-to-TGW candidate)");
  await point.fill("203.0.113.1");
  expect(await parent.evaluate((node) => (node as HTMLFormElement).checkValidity())).toBe(true);
  await cidr.press("Enter");
  expect(pointRequests).toBe(0);
  const pointPending = page.waitForResponse((value) => value.url().includes("/tgw-source-lookup?"));
  await parent.getByRole("button", { name: "Inspect saved ingress candidate", exact: true }).click();
  expect((await pointPending).status()).toBe(200);
  expect(cidrRequests).toBe(1);
  expect(await saved(source.id)).toEqual(sourceBefore);
  expect(await saved(network.id)).toEqual(networkBefore);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(before);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
});

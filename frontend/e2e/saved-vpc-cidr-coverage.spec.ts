import { expect, test } from "@playwright/test";

// Actual current server/static UI and isolated PostgreSQL; synthetic observations, SDK off.
test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: reader inspects exact saved CIDR decisions without missing an internal blackhole", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const beforeResponse = await request.get("/api/v1/snapshot", { headers });
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json();
  const source = before.aws_accounts.find(
    (account: { name: string }) => account.name === "Browser saved TGW A",
  );
  const saved = async () => {
    const response = await request.get(`/api/v1/aws/accounts/${source.id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const view = await saved();
  const subnet = "subnet-browser-attachment-1";
  const path = `/api/v1/aws/accounts/${source.id}/vpc-cidr-coverage`;
  const query = new URLSearchParams({ subnet_id: subnet, destination_cidr: "10.10.0.0/16" });
  const oracleResponse = await request.get(`${path}?${query}`, { headers });
  expect(oracleResponse.status()).toBe(200);
  const oracle = await oracleResponse.json();
  expect(oracle.account_id).toBe(source.id);
  expect(oracle.topology_id).toBe(view.topology.id);
  expect(oracle.completed_at).toBe(view.topology.completed_at);
  expect(oracle.reference_only).toBe(true);
  expect(oracle.execution_enabled).toBe(false);
  expect(oracle.connectivity_tested).toBe(false);
  expect(oracle.coverage.partition_complete).toBe(true);
  expect(oracle.coverage.table_evidence.original_table).toEqual(
    view.topology.resources[oracle.coverage.table_evidence.route_table_resource_index],
  );
  expect(
    oracle.coverage.segments.map(
      (cell: { start: string; end_inclusive: string; result: { lookup: { status: string } } }) => [
        cell.start,
        cell.end_inclusive,
        cell.result.lookup.status,
      ],
    ),
  ).toEqual([
    ["10.10.0.0", "10.10.0.255", "reported_route"],
    ["10.10.1.0", "10.10.1.255", "reported_blackhole"],
    ["10.10.2.0", "10.10.255.255", "reported_route"],
  ]);
  const queries: string[] = [],
    points: string[] = [];
  page.on("request", (event) => {
    if (event.url().includes("/vpc-cidr-coverage?")) queries.push(event.url());
    if (event.url().includes("/vpc-route-lookup?")) points.push(event.url());
  });
  await page.goto("/");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const account = (name: string) => page.locator("#aws-account-list li").filter({ hasText: name });
  await account("Browser saved TGW A").getByRole("button", { name: "View saved AWS observation" }).click();
  const row = page
    .locator("#aws-topology article")
    .filter({ has: page.getByRole("heading", { name: `subnet · ${subnet}`, exact: true }) });
  const summary = row.getByText("Inspect saved destination-CIDR decisions", { exact: true });
  await expect(summary).toHaveCount(1); // Genuine missing-control RED only after the real API oracle.
  expect(queries).toHaveLength(0);
  await expect(row.locator("[data-vpc-cidr-coverage]")).toHaveCount(0);
  await summary.click();
  const inspector = row.locator("[data-vpc-cidr-coverage]");
  const input = inspector.getByLabel("Destination CIDR (saved decisions)");
  const action = inspector.getByRole("button", { name: "Inspect saved CIDR decisions", exact: true });
  const status = inspector.locator(":scope > [role=status]");
  await expect(input).toHaveValue("");
  expect(queries).toHaveLength(0);
  const point = row.locator(`form[data-vpc-route-lookup="${subnet}"]`);
  await point.getByLabel("Destination IP (saved subnet route lookup)").fill("10.10.254.10");
  expect(await point.evaluate((element: HTMLFormElement) => element.checkValidity())).toBe(true);
  await input.press("Enter");
  expect(points).toHaveLength(0);
  expect(queries).toHaveLength(0);
  for (const [cidr, code, count] of [
    ["10.10.0.0/16", 200, 3],
    ["203.0.113.0/24", 200, 1],
    ["10.10.0.1/16", 422, 0],
    ["10.10.0.0/16", 200, 3],
  ] as const) {
    await input.fill(cidr);
    const pending = page.waitForResponse((event) => event.url().includes("/vpc-cidr-coverage?"));
    await action.click();
    const response = await pending;
    expect(response.status()).toBe(code);
    const url = new URL(response.url());
    expect(url.pathname).toBe(path);
    expect([...url.searchParams.keys()].sort()).toEqual(["destination_cidr", "subnet_id"]);
    expect(url.searchParams.get("destination_cidr")).toBe(cidr);
    if (!count) {
      await expect(status).toContainText("invalid_destination_cidr");
      await expect(inspector.locator("[data-vpc-cidr-interval]")).toHaveCount(0);
      continue;
    }
    await expect(status).toContainText(`Partition complete: ${count}`);
    await expect(inspector.locator("[data-vpc-cidr-interval]")).toHaveCount(0);
    await inspector.getByText(`Decision intervals (${count})`, { exact: true }).click();
    await expect(inspector.locator("[data-vpc-cidr-interval]")).toHaveCount(count);
    await expect(inspector).toContainText(
      cidr === "10.10.0.0/16" ? "reported_blackhole" : "no_matching_route",
    );
    await expect(inspector).toContainText(`completed ${view.topology.completed_at}`);
    await expect(inspector).toContainText("not usable connectivity");
  }
  await point.getByRole("button", { name: "Look up saved subnet route", exact: true }).click();
  await expect(point.locator(":scope > [role=status]")).toContainText("Reported subnet entry");
  expect(points).toHaveLength(1);
  await expect(inspector.locator("a,img,form,[data-nat-reference]")).toHaveCount(0);
  expect(await saved()).toEqual(view);
  expect(await (await request.get("/api/v1/snapshot", { headers })).json()).toEqual(before);
  await account("Browser saved TGW B").getByRole("button", { name: "View saved AWS observation" }).click();
  await expect(page.locator("[data-vpc-cidr-coverage]")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();
});

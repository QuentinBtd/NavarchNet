import { expect, test } from "@playwright/test";
import type { Snapshot, TopologyView } from "../src/generated";

test.use({ baseURL: "http://127.0.0.1:18083" });
test("real browser: saved AWS records have a capture-bound map and readonly inspector", async ({
  page,
  request,
}, testInfo) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const snapshot = async () => {
    const response = await request.get("/api/v1/snapshot", { headers });
    expect(response.status()).toBe(200);
    return (await response.json()) as Snapshot;
  };
  const before = await snapshot();
  expect(before.aws_read_only_enabled).toBe(false);
  const account = before.aws_accounts.find((a) => a.name === "Browser saved TGW B");
  const other = before.aws_accounts.find((a) => a.name === "Browser saved TGW A");
  if (!account || !other) throw new Error("Saved fixture registrations missing");
  const saved = async () => {
    const response = await request.get(`/api/v1/aws/accounts/${account.id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return (await response.json()) as TopologyView;
  };
  const view = await saved();
  expect(view.topology.execution_enabled).toBe(false);
  expect(view.topology.connectivity_tested).toBe(false);
  expect(view.topology.account_id).toBe(account.id);
  const index = view.topology.resources.findIndex((r) => r.id === "nat-browser-regional");
  expect(index).toBeGreaterThanOrEqual(0);
  const record = view.topology.resources[index];
  expect(record.nat_gateway?.addresses?.map((a) => a.status)).toEqual([
    "succeeded",
    "failed",
    "future-<img src=x>",
  ]);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await page.goto("/#/aws");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const open = async (name: string) => {
    await page
      .locator("#aws-account-list li")
      .filter({ hasText: name })
      .getByRole("button", { name: "View saved AWS observation", exact: true })
      .click();
  };
  await open(account.name);
  // Original saved bytes/registration/tuple fixture/false markers are established before UI RED.
  const map = page.getByRole("region", { name: "Saved AWS resource map", exact: true });
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  await expect(map).toHaveAttribute("data-completed-at", view.topology.completed_at);
  await page.getByLabel("Observed resource kind", { exact: true }).selectOption("nat_gateway");
  await map.locator(`button[data-record-index="${index}"]`).click();
  const inspector = map.getByRole("complementary", { name: "Saved AWS record inspector" });
  await expect(inspector).toContainText(record.id);
  await expect(inspector).toContainText("Reported metadata is not health or a usable path");
  await inspector.getByText("Original captured record", { exact: true }).click();
  expect(JSON.parse(await inspector.locator("pre").innerText())).toEqual(record);
  await expect(inspector).toContainText("future-<img src=x>");
  await expect(map.locator("img,svg path,form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Authorize metadata adoption" })).toHaveCount(0);
  await inspector.getByText("Original captured record", { exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await map.screenshot({ path: testInfo.outputPath("saved-aws-workspace-running-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await map.screenshot({ path: testInfo.outputPath("saved-aws-workspace-running-mobile.png") });
  await open(other.name);
  await expect(map).not.toHaveAttribute("data-topology-id", view.topology.id);
  await open(account.name);
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  expect(await saved()).toEqual(view);
  expect(await snapshot()).toEqual(before);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();

  // All original saved-map, account replacement, nonmutation and logout assertions remain unchanged.
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await open(account.name);
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/")) calls.push(r.url());
  });
  await map.getByLabel("Observed resource kind", { exact: true }).selectOption("nat_gateway");
  await map.locator(`button[data-record-index="${index}"]`).click();
  const metadata = inspector.locator("details[data-nat-metadata]");
  await expect(metadata.getByText("Inspect reported NAT metadata", { exact: true })).toBeVisible();
  await metadata.getByText("Inspect reported NAT metadata", { exact: true }).click();
  await expect(metadata).toContainText(
    `Saved snapshot: ${view.topology.id} · completed: ${view.topology.completed_at}`,
  );
  await expect(metadata).toContainText("not selected egress IPs, not NAT health or a selected traffic AZ");
  const addresses = record.nat_gateway?.addresses;
  if (!addresses) throw new Error("Saved address tuples missing");
  const rows = metadata.locator("li[data-nat-address]");
  await expect(rows).toHaveCount(addresses.length);
  for (const [i, address] of addresses.entries()) {
    await expect(rows.nth(i)).toContainText(
      `Public IP: ${address.public_ip ?? "not reported"} · Private IP: ${address.private_ip ?? "not reported"}`,
    );
    await expect(rows.nth(i)).toContainText(
      `AZ ID: ${address.az_id ?? "not reported"} · AZ name (account-specific): ${address.az_name ?? "not reported"}`,
    );
    await expect(rows.nth(i)).toContainText(
      `Reported status: ${address.status ?? "not reported"} · Reported primary: ${address.is_primary ?? "not reported"}`,
    );
    await expect(rows.nth(i)).toContainText(
      `Allocation: ${address.allocation_id ?? "not reported"} · Association: ${address.association_id ?? "not reported"} · Interface: ${address.network_interface_id ?? "not reported"}`,
    );
  }
  for (const [width, height, label] of [
    [1440, 1080, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await map.screenshot({ path: testInfo.outputPath(`saved-map-nat-tuples-${label}.png`) });
  }
  expect(calls).toEqual([]);
  expect(writes).toEqual([]);
  expect(await saved()).toEqual(view);
  expect(await snapshot()).toEqual(before);
});

test("real browser: map inspector retains original saved VPC and TGW route entries", async ({
  page,
  request,
}, testInfo) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const beforeResponse = await request.get("/api/v1/snapshot", { headers });
  expect(beforeResponse.status()).toBe(200);
  const before = (await beforeResponse.json()) as Snapshot;
  expect(before.aws_read_only_enabled).toBe(false);
  const account = before.aws_accounts.find((a) => a.name === "Browser saved TGW A");
  if (!account) throw new Error("Saved registration missing");
  const saved = async () => {
    const response = await request.get(`/api/v1/aws/accounts/${account.id}/topology`, { headers });
    expect(response.status()).toBe(200);
    return (await response.json()) as TopologyView;
  };
  const view = await saved();
  expect(view.topology.account_id).toBe(account.id);
  expect(view.topology.execution_enabled).toBe(false);
  expect(view.topology.connectivity_tested).toBe(false);
  const records = ["route_table", "transit_gateway_route_table"].map((kind) => {
    const index = view.topology.resources.findIndex(
      (r) =>
        r.kind === kind && (kind === "route_table" ? r.routes.length > 0 : (r.tgw_routes?.length ?? 0) > 0),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const record = view.topology.resources[index];
    const routes = kind === "route_table" ? record.routes : record.tgw_routes;
    if (!routes?.length) throw new Error("Stored route collection missing");
    return { kind, index, record, routes };
  });
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await page.goto("/#/aws");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: account.name })
    .getByRole("button", { name: "View saved AWS observation", exact: true })
    .click();
  const map = page.getByRole("region", { name: "Saved AWS resource map", exact: true });
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  for (const { kind, index, record, routes } of records) {
    await map.getByLabel("Observed resource kind", { exact: true }).selectOption(kind);
    await map.locator(`button[data-record-index="${index}"]`).click();
    const inspector = map.getByRole("complementary", { name: "Saved AWS record inspector" });
    await expect(inspector).toContainText(record.id);
    // Both original real stored collections and false markers are established before missing-control RED.
    await expect(inspector.getByText("Reported route entries", { exact: true })).toBeVisible();
    await inspector.getByText("Reported route entries", { exact: true }).click();
    const detail = inspector.locator("details[data-captured-route-entries]");
    await expect(detail).toHaveAttribute("data-capture-id", view.topology.id);
    await expect(detail).toHaveAttribute("data-resource-index", String(index));
    await expect(detail).toContainText("Not effective routing or measured traffic");
    for (let shown = 12; shown < routes.length; shown += 12)
      await detail.getByRole("button", { name: "Show more captured routes", exact: true }).click();
    const rows = detail.locator("li[data-route-index]");
    await expect(rows).toHaveCount(routes.length);
    for (let i = 0; i < routes.length; i++) {
      const row = rows.nth(i);
      await expect(row).toHaveAttribute("data-route-index", String(i));
      await row.getByText("Original route record", { exact: true }).click();
      expect(JSON.parse(await row.locator("pre").innerText())).toEqual(routes[i]);
      await row.getByText("Original route record", { exact: true }).click();
    }
    await expect(detail.locator("form,input,select,a,img")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1080 });
    expect((await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(
      ((await map.boundingBox())?.width ?? 0) * 0.35,
    );
    await map.screenshot({ path: testInfo.outputPath(`captured-${kind}-routes-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await map.screenshot({ path: testInfo.outputPath(`captured-${kind}-routes-mobile.png`) });
  }
  expect(await saved()).toEqual(view);
  const afterResponse = await request.get("/api/v1/snapshot", { headers });
  expect(afterResponse.status()).toBe(200);
  expect(await afterResponse.json()).toEqual(before);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#aws-topology")).toBeEmpty();

  // All original route-completeness, provenance, nonmutation and logout assertions stay unchanged.
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: account.name })
    .getByRole("button", { name: "View saved AWS observation", exact: true })
    .click();
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  const filterCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/")) filterCalls.push(r.url());
  });
  for (const { kind, index, record, routes } of records) {
    const destinations =
      kind === "route_table"
        ? record.routes.map((r) => r.ipv4_destination)
        : (record.tgw_routes ?? []).map((r) => r.destination_cidr);
    const expected = destinations.flatMap((d, i) => (d === "0.0.0.0/0" ? [i] : []));
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(routes.length);
    await map.getByLabel("Observed resource kind", { exact: true }).selectOption(kind);
    await map.locator(`button[data-record-index="${index}"]`).click();
    const inspector = map.getByRole("complementary", { name: "Saved AWS record inspector" });
    await inspector.getByText("Reported route entries", { exact: true }).click();
    const detail = inspector.locator("details[data-captured-route-entries]");
    const defaults = detail.getByRole("button", { name: "Show reported IPv4 defaults", exact: true });
    await expect(defaults).toBeVisible();
    await defaults.click();
    const rows = detail.locator("li[data-route-index]");
    expect(
      await rows.evaluateAll((nodes) => nodes.map((n) => Number((n as HTMLElement).dataset.routeIndex))),
    ).toEqual(expected);
    for (const originalIndex of expected) {
      const row = detail.locator(`li[data-route-index="${originalIndex}"]`);
      await expect(row).toHaveAttribute("value", String(originalIndex + 1));
      await row.getByText("Original route record", { exact: true }).click();
      expect(JSON.parse(await row.locator("pre").innerText())).toEqual(routes[originalIndex]);
      await row.getByText("Original route record", { exact: true }).click();
    }
    await expect(detail).toContainText("literal 0.0.0.0/0");
    await expect(detail).toContainText("Not effective routing or measured traffic");
    for (const [width, height, label] of [
      [1440, 1080, "desktop"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await map.screenshot({ path: testInfo.outputPath(`captured-default-${kind}-${label}.png`) });
    }
    await detail.getByRole("button", { name: "Show all captured routes", exact: true }).click();
    await expect(rows).toHaveCount(routes.length);
    expect(
      await rows.evaluateAll((nodes) => nodes.map((n) => Number((n as HTMLElement).dataset.routeIndex))),
    ).toEqual(routes.map((_, i) => i));
  }
  expect(filterCalls).toEqual([]);
  expect(writes).toEqual([]);
  expect(await saved()).toEqual(view);
  const finalSnapshot = await request.get("/api/v1/snapshot", { headers });
  expect(finalSnapshot.status()).toBe(200);
  expect(await finalSnapshot.json()).toEqual(before);
});

test("real browser: saved map filters loaded records by literal ID without new reads", async ({
  page,
  request,
}, testInfo) => {
  const headers = { Authorization: "Bearer browser-test-reader-credential-free-local-only" };
  const snapshotResponse = await request.get("/api/v1/snapshot", { headers });
  expect(snapshotResponse.status()).toBe(200);
  const before = (await snapshotResponse.json()) as Snapshot;
  const account = before.aws_accounts.find((a) => a.name === "Browser saved TGW B");
  if (!account) throw new Error("Saved registration missing");
  const url = `/api/v1/aws/accounts/${account.id}/topology`;
  const response = await request.get(url, { headers });
  expect(response.status()).toBe(200);
  const view = (await response.json()) as TopologyView;
  expect(view.topology.account_id).toBe(account.id);
  expect(view.topology.execution_enabled).toBe(false);
  expect(view.topology.connectivity_tested).toBe(false);
  const index = view.topology.resources.findIndex((r) => r.id === "nat-browser-regional");
  expect(index).toBeGreaterThanOrEqual(0);
  const record = view.topology.resources[index];
  await page.goto("/#/aws");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-reader-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .locator("#aws-account-list li")
    .filter({ hasText: account.name })
    .getByRole("button", { name: "View saved AWS observation", exact: true })
    .click();
  const map = page.getByRole("region", { name: "Saved AWS resource map", exact: true });
  await expect(map).toHaveAttribute("data-topology-id", view.topology.id);
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/")) calls.push(r.url());
  });
  // Real original capture and false markers established before missing-UI RED.
  const filter = map.getByLabel("Filter saved ID or Name (case-sensitive)", { exact: true });
  await expect(filter).toBeVisible();
  await filter.fill(record.id.slice(0, 3));
  await filter.press("End");
  await filter.pressSequentially(record.id.slice(3));
  await expect(filter).toHaveValue(record.id);
  const matches = view.topology.resources.flatMap((r, i) =>
    r.id.includes(record.id) || (r.tags.Name ?? "").includes(record.id) ? [i] : [],
  );
  await expect(map.locator("button[data-record-index]")).toHaveCount(Math.min(24, matches.length));
  await map.locator(`button[data-record-index="${index}"]`).click();
  const inspector = map.getByRole("complementary", { name: "Saved AWS record inspector" });
  await inspector.getByText("Original captured record", { exact: true }).click();
  expect(JSON.parse(await inspector.locator("pre").innerText())).toEqual(record);
  await filter.fill("no-record-with-this-literal-<img src=x>");
  await expect(map.locator("button[data-record-index]")).toHaveCount(0);
  await expect(map).toContainText("No resource absence is inferred");
  await expect(inspector.locator("pre")).toHaveCount(0);
  await filter.fill(record.id);
  await page.setViewportSize({ width: 1440, height: 1080 });
  await map.screenshot({ path: testInfo.outputPath("saved-map-filter-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await map.screenshot({ path: testInfo.outputPath("saved-map-filter-mobile.png") });
  await filter.fill("");
  await expect(map.locator("button[data-record-index]")).toHaveCount(
    Math.min(24, view.topology.resources.length),
  );
  expect(calls).toEqual([]);
  const after = await request.get(url, { headers });
  expect(await after.json()).toEqual(view);
  const finalSnapshot = await request.get("/api/v1/snapshot", { headers });
  expect(await finalSnapshot.json()).toEqual(before);

  // All original saved-map filtering, nonmutation and snapshot assertions above remain unchanged.
  const subnets = view.topology.resources.flatMap((resource, index) =>
    resource.kind === "subnet" ? [{ resource, index }] : [],
  );
  expect(subnets.length).toBeGreaterThan(0);
  for (const [position, { resource, index }] of subnets.entries()) {
    const returned = view.subnet_route_tables.filter((row) => row.subnet_id === resource.id);
    expect(returned).toHaveLength(1);
    expect(returned[0].vpc_id).toBe(resource.vpc_id);
    expect(view.topology.resources.filter((row) => row.id === resource.id)).toHaveLength(1);
    await map.getByLabel("Observed resource kind", { exact: true }).selectOption("subnet");
    await map.locator(`button[data-record-index="${index}"]`).click();
    const calculated = inspector.locator("[data-captured-subnet-table]");
    await expect(
      calculated.getByText("Calculated table selection from this capture", { exact: true }),
    ).toBeVisible();
    await expect(calculated).toContainText(
      `Capture ${view.topology.id} · completed ${view.topology.completed_at}`,
    );
    const selection = returned[0].selection;
    if (selection.status === "selected") {
      await expect(calculated).toContainText(`Selected table: ${selection.route_table_id}`);
      await expect(calculated).toContainText(`Association source: ${selection.source}`);
    } else await expect(calculated).toContainText(`Selection unresolved: ${selection.reason}`);
    await expect(calculated).toContainText("Not a destination-route decision, health check or verified path");
    if (position === 0)
      for (const [width, height, label] of [
        [1440, 1080, "desktop"],
        [390, 844, "mobile"],
      ] as const) {
        await page.setViewportSize({ width, height });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await map.screenshot({ path: testInfo.outputPath(`saved-map-subnet-table-${label}.png`) });
      }
  }
  expect(calls).toEqual([]);
  const readback = await request.get(url, { headers });
  expect(await readback.json()).toEqual(view);
  const coreReadback = await request.get("/api/v1/snapshot", { headers });
  expect(await coreReadback.json()).toEqual(before);
});

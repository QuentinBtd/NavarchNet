import { expect, test } from "@playwright/test";

test("compact console has one routed workspace, direct links and real history", async ({ page }) => {
  await page.goto("/#/networks");
  await page
    .getByLabel("Demo token or OIDC access token")
    .fill("browser-test-admin-credential-free-local-only");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#networks")).toBeVisible();
  await expect(page.locator("#overview")).toBeHidden();
  await expect(page.locator(".hero")).toHaveCount(0);
  await expect(page.locator("[data-workspace]:visible")).toHaveCount(1);
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await navigation.getByRole("link", { name: "Accounts & discovery", exact: true }).click();
  await expect(page).toHaveURL(/#\/accounts$/);
  await expect(page.locator("#accounts")).toBeVisible();
  await expect(page.locator("#networks")).toBeHidden();
  await page.goBack();
  await expect(page.locator("#networks")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#accounts")).toBeVisible();
  const operations = navigation.getByRole("link", { name: "Operations", exact: true });
  await operations.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/operations$/);
  await expect(page.locator("#operations h2")).toBeFocused();
  await expect(page.locator("#accounts")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-workspace]:visible")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#session")).toBeVisible();
  await expect(page.locator("#token")).toHaveValue("");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(page.url()).not.toContain("credential");
});

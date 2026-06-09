import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Sidebar takeover model (PAP-10695).
 *
 * Takeover routes (company settings, plugin `routeSidebar`) no longer *replace*
 * the main app sidebar. Instead the host collapses the app `<Sidebar/>` to its
 * 64px rail (still peek-able) and renders the contextual sidebar in a second
 * pane → `[ app rail ][ secondary ~240px ][ content ]`.
 *
 * These specs assert the rail + secondary pane coexist on a company settings
 * route, and that an explicit user pin (expanded) wins over the route-driven
 * collapse (pin precedence).
 *
 * The plugin `routeSidebar` half of this behavior shares the exact same Layout
 * code path (one `secondarySidebar`/`hasSecondarySidebar` resolver drives both
 * company-settings and plugin routes) and is covered by the unit tests in
 * `ui/src/components/Layout.test.tsx`. A live plugin-route e2e requires the
 * `plugin-llm-wiki` plugin to be installed in the throwaway e2e instance, which
 * is out of scope for this default local_trusted run; visual QA of both panes
 * is delegated to the QA child issue.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-SidebarTakeover-${Date.now()}`;
const COLLAPSED_STORAGE_KEY = "paperclip.sidebar.collapsed";

// The sidebar header's "Open search" control only renders when the app sidebar
// is expanded (pinned or peeking); in the collapsed rail it is hidden to fit
// the 64px width. Its presence/absence is therefore a stable proxy for the
// app sidebar's collapsed state (see Sidebar.tsx).
const APP_SIDEBAR_EXPANDED_MARKER = "Open search";

async function createCompany(board: APIRequestContext): Promise<{ id: string; prefix: string }> {
  const healthRes = await board.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  expect(health.deploymentMode).toBe("local_trusted");

  const companyRes = await board.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  if (!companyRes.ok()) {
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${await companyRes.text()}`);
  }
  const company = await companyRes.json();
  return {
    id: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

test.describe("Sidebar takeover (collapse + secondary pane)", () => {
  let board: APIRequestContext;
  let companyId: string;
  let prefix: string;

  test.beforeAll(async () => {
    board = await pwRequest.newContext({ baseURL: BASE_URL });
    const company = await createCompany(board);
    companyId = company.id;
    prefix = company.prefix;
  });

  test.afterAll(async () => {
    await board.delete(`${BASE_URL}/api/companies/${companyId}`).catch(() => {});
    await board.dispose();
  });

  test.beforeEach(async ({ page }) => {
    // Start each test from a clean (unpinned) sidebar state so the route-driven
    // collapse is the only thing acting on it.
    await page.addInitScript((key) => {
      window.localStorage.removeItem(key);
    }, COLLAPSED_STORAGE_KEY);
  });

  test("collapses the app sidebar to its rail and shows the settings sidebar beside it", async ({ page }) => {
    await page.goto(`/${prefix}/company/settings`);

    // The contextual (secondary) pane is present...
    const secondary = page.locator("[data-secondary-sidebar]");
    await expect(secondary).toBeVisible();
    await expect(secondary).toHaveCount(1);

    // ...and it is ~240px wide (w-60), distinct from the 64px app rail.
    const secondaryBox = await secondary.boundingBox();
    expect(secondaryBox).not.toBeNull();
    expect(secondaryBox!.width).toBeGreaterThan(180);

    // The app sidebar is NOT replaced — its company nav still renders...
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();

    // ...but it is collapsed to its rail: the expanded-only "Open search"
    // header control is hidden.
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);
  });

  test("an explicit expanded pin overrides the route-driven collapse", async ({ page }) => {
    // User has pinned the sidebar expanded ("0"). The settings route still
    // requests a collapse, but the pin must win (pin > route request > default).
    await page.addInitScript(
      ({ key }) => {
        window.localStorage.setItem(key, "0");
      },
      { key: COLLAPSED_STORAGE_KEY },
    );

    await page.goto(`/${prefix}/company/settings`);

    // Secondary pane still shows on the takeover route.
    await expect(page.locator("[data-secondary-sidebar]")).toBeVisible();

    // The app sidebar stays expanded despite the route request: the
    // expanded-only header control is visible.
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toBeVisible();
  });

  test("leaving the takeover route removes the secondary pane and restores the sidebar", async ({ page }) => {
    await page.goto(`/${prefix}/company/settings`);
    await expect(page.locator("[data-secondary-sidebar]")).toBeVisible();
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);

    // Navigate to a plain (non-takeover) route.
    await page.goto(`/${prefix}/dashboard`);

    // No secondary pane, and the app sidebar is no longer force-collapsed.
    await expect(page.locator("[data-secondary-sidebar]")).toHaveCount(0);
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toBeVisible();
  });
});

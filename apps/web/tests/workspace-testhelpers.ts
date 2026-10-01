import { expect, type Locator, type Page } from "@playwright/test";

type Selection = { id: string; origin: string };
const selections = new WeakMap<Page, Selection>();

/** Remember the choice before navigation, so a dropped UUID cannot satisfy an assertion. */
export function rememberWorkspace(page: Page): string {
  const url = new URL(page.url());
  const id = url.searchParams.get("workspace");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Expected a selected workspace URL");
  selections.set(page, { id, origin: url.origin });
  return id;
}

export async function finishWorkspaceEntry(page: Page, options: { branchName?: string; allowEmpty?: boolean } = {}): Promise<string | null> {
  await expect(page).toHaveURL(url => url.pathname === "/admin" || url.pathname.startsWith("/admin/"));
  if (new URL(page.url()).pathname === "/admin/workspaces") {
    await expect(page.getByRole("heading", { name: "اختيار مساحة العمل", exact: true })).toBeVisible();
    const center = page.getByRole("button", { name: "إدارة المركز", exact: true });
    if (!options.branchName && await center.count()) await center.click();
    else {
      const branch = options.branchName ? page.getByRole("button", { name: options.branchName, exact: true }) : page.getByLabel("الفروع المتاحة", { exact: true }).getByRole("button").first();
      if (!await branch.count() && options.allowEmpty) {
        await expect(page.getByText("لا توجد فروع متاحة لك.", { exact: false })).toBeVisible();
        selections.delete(page);
        return null;
      }
      await expect(branch).toBeVisible();
      await branch.click();
    }
    await expect(page).not.toHaveURL(url => url.pathname === "/admin/workspaces");
  } else if (!options.branchName) {
    // Managers with one branch enter it automatically; old aggregate suites choose center explicitly.
    const response = await page.request.get(new URL("/api/v1/center/workspaces", page.url()).href);
    expect(response.ok()).toBe(true);
    const data = await response.json();
    await expect(page.locator("[data-workspace-name]")).toBeVisible();
    if (data.permissions.can_manage_center && await page.locator("[data-workspace-name]").textContent() !== "إدارة المركز") {
      await page.getByRole("link", { name: "تبديل مساحة العمل", exact: true }).click();
      const selected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/center/workspaces" && response.request().method() === "POST");
      await page.getByRole("button", { name: "إدارة المركز", exact: true }).click();
      const selectedResponse = await selected;
      expect(selectedResponse.ok()).toBe(true);
      const chosen = await selectedResponse.json();
      expect(chosen.workspace.mode).toBe("center");
      await expect(page).toHaveURL(new URL(chosen.destination, page.url()).href);
      await expect(page.locator("[data-workspace-name]")).toHaveText("إدارة المركز");
    }
  }
  if (!new URL(page.url()).searchParams.has("workspace")) {
    const response = await page.request.get(new URL("/api/v1/center/user", page.url()).href);
    expect(response.ok()).toBe(true);
    const data = await response.json();
    if (!data.workspace?.id) throw new Error("Restored session has no selected workspace");
    const url = new URL(page.url());
    url.searchParams.set("workspace", data.workspace.id);
    await page.goto(url.href);
  }
  await expect(page.locator(".route-progress")).toHaveCount(0);
  return rememberWorkspace(page);
}

function selection(page: Page): Selection {
  const selected = selections.get(page);
  if (!selected) throw new Error("Call finishWorkspaceEntry or rememberWorkspace before the action under test");
  return selected;
}

/** Test fixture navigation retains the captured choice; application clicks remain unmodified. */
export function workspaceUrl(page: Page, route: string): string {
  const selected = selection(page);
  const url = new URL(route, selected.origin);
  if (url.origin === selected.origin && /^\/admin(?:\/|$)/.test(url.pathname)) url.searchParams.set("workspace", selected.id);
  return url.href;
}

export function workspacePath(page: Page, route: string): string {
  const url = new URL(workspaceUrl(page, route));
  return url.pathname + url.search + url.hash;
}

function canonical(url: URL): string {
  url.searchParams.sort();
  return url.href;
}

export async function expectWorkspaceUrl(page: Page, route: string): Promise<void> {
  const expected = canonical(new URL(workspaceUrl(page, route)));
  await expect(page, `Expected captured workspace URL: ${expected}`).toHaveURL(url => canonical(new URL(url)) === expected);
}

export async function expectWorkspaceHref(page: Page, link: Locator, route: string): Promise<void> {
  const expected = canonical(new URL(workspaceUrl(page, route)));
  const origin = selection(page).origin;
  await expect.poll(async () => {
    const href = await link.getAttribute("href");
    return href ? canonical(new URL(href, origin)) : null;
  }).toBe(expected);
}

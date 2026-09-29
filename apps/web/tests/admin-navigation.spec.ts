import { expect, test } from "@playwright/test";
import { credentials, signIn } from "./local-fixtures";

test("keyboard intent preloads the SSR workspace before navigation", async ({ page }) => {
  const owner = credentials("alpha");
  await signIn(page, "http://alpha.courses.test", owner.email, owner.password);
  const members = page.getByRole("link", { name: "إدارة الموظفين والدعوات", exact: true });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/admin/members?")) requests.push(request.url());
  });
  // Focus the preceding link, then advance using the actual keyboard.
  await page.getByRole("link", { name: "المناهج والخطط", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(members).toBeFocused();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");
  expect(page.url()).toBe("http://alpha.courses.test/admin");
  const prefetched = requests.length;
  await members.click();
  await expect(page.getByRole("table", { name: "العضويات", exact: true })).toBeVisible();
  expect(requests.length).toBe(prefetched);
});

test("admin content is available as SSR HTML without JavaScript", async ({ page, browser }) => {
  const owner = credentials("alpha");
  await signIn(page, "http://alpha.courses.test", owner.email, owner.password);
  const context = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  try {
    const serverPage = await context.newPage();
    await serverPage.goto("http://alpha.courses.test/admin/members");
    await expect(serverPage.getByRole("heading", { name: "موظفو المركز", exact: true })).toBeVisible();
    await expect(serverPage.getByRole("table", { name: "العضويات", exact: true })).toBeVisible();
    await expect(serverPage.getByRole("textbox", { name: "البريد الإلكتروني", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("admin navigation retains the document, sidebar and header", async ({ page }) => {
  const owner = credentials("alpha");
  await signIn(page, "http://alpha.courses.test", owner.email, owner.password);
  await page.getByRole("button", { name: "طي القائمة الجانبية" }).click();
  const sidebar = await page.locator(".center-sidebar").elementHandle();
  const header = await page.locator(".center-topbar").elementHandle();
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
  });

  for (const [link, heading] of [
    ["إدارة الموظفين والدعوات", "موظفو المركز"],
    ["الإعدادات", "الإعدادات"],
    ["الرئيسية", "الرئيسية"],
  ]) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.locator(".center-topbar").getByRole("heading", { name: heading, exact: true })).toBeVisible();
    expect(documents).toEqual([]);
    expect(await sidebar!.evaluate((node) => node === document.querySelector(".center-sidebar"))).toBe(true);
    expect(await header!.evaluate((node) => node === document.querySelector(".center-topbar"))).toBe(true);
    await expect(page.locator(".center-shell")).toHaveClass(/sidebar-collapsed/);
  }
  await page.getByRole("link", { name: "الإعدادات", exact: true }).click();
  await page.getByRole("tab", { name: "الفروع", exact: true }).click();
  await page.getByRole("button", { name: "إنشاء فرع", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "اسم الفرع", exact: true })).toBeFocused();
});

test("slow admin navigation keeps content and header geometry until the destination is ready", async ({ page }) => {
  const owner = credentials("alpha");
  await signIn(page, "http://alpha.courses.test", owner.email, owner.password);
  const height = await page.locator(".center-topbar").evaluate((node) => node.getBoundingClientRect().height);
  let release!: () => void;
  let received!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/admin/members?*", async (route) => {
    received();
    await blocked;
    await route.continue();
  });
  await page.getByRole("link", { name: "إدارة الموظفين والدعوات", exact: true }).click();
  await intercepted;
  await expect(page.locator(".center-topbar").getByRole("heading", { name: "الرئيسية", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "جارٍ تحميل محتوى الصفحة" })).toBeVisible();
  expect(await page.locator(".center-topbar").evaluate((node) => node.getBoundingClientRect().height)).toBe(height);
  release();
  await expect(page.getByRole("table", { name: "العضويات", exact: true })).toBeVisible();
  expect(await page.locator(".center-topbar").evaluate((node) => node.getBoundingClientRect().height)).toBe(height);
});

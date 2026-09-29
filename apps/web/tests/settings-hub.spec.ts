import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_SETTINGS_CREDENTIALS || !process.env.COURSES_SETTINGS_READ_LOG, "Requires the isolated settings browser fixture and query proxy.");

const origin = process.env.COURSES_SETTINGS_ORIGIN ?? "http://alpha.courses.test:8057";
const accounts = process.env.COURSES_SETTINGS_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_SETTINGS_CREDENTIALS, "utf8")) as Record<string, { email: string; password: string }>
  : {};

async function signIn(page: Page, account: "alpha" | "staff") {
  await page.goto(`${origin}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني", exact: true }).fill(accounts[account].email);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(accounts[account].password);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/admin`);
}

function queryCursor() {
  return readFileSync(process.env.COURSES_SETTINGS_READ_LOG!, "utf8").length;
}

function readsSince(cursor: number) {
  return readFileSync(process.env.COURSES_SETTINGS_READ_LOG!, "utf8")
    .slice(cursor).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { path: string; count: number | null; status: number });
}

test("owner opens only the selected settings data and legacy links retain parameters", async ({ page, browser }) => {
  await signIn(page, "alpha");
  await expect(page.locator(".center-topbar").getByRole("heading", { name: "الرئيسية" })).toBeVisible();
  await expect(page.locator("main").getByRole("table")).toHaveCount(0);
  const routes = [
    ["general", "عام", "بريد التواصل", "user?include=settings"],
    ["branches", "الفروع", "الفرع الشمالي", "user"],
    ["students", "الطلاب", "ترقيم الطلاب", "user?include=student-settings"],
    ["student-fields", "الحقول الإضافية", "إضافة حقل", "student-custom-fields?"],
    ["student-choices", "قوائم بيانات الطالب", "إضافة اختيار", "student-profile-choices?"],
    ["security", "أمان الحساب", "التحقق بخطوتين", "user"],
  ] as const;
  for (const [tab, label, content, expectedRequest] of routes) {
    const cursor = queryCursor();
    const response = await page.goto(`${origin}/admin/settings?tab=${tab}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
    if (tab === "students" || tab === "student-fields" || tab === "student-choices") {
      await expect(page.getByRole("tablist", { name: "أقسام الإعدادات" }).getByRole("tab", { name: "الطلاب" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tablist", { name: "أقسام الطلاب" }).getByRole("tab", { name: tab === "students" ? "إعدادات الطلاب" : label })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tablist", { name: "أقسام الإعدادات" }).getByRole("tab", { name: "الحقول الإضافية" })).toHaveCount(0);
    }
    await expect(page.getByText(content, { exact: false }).first()).toBeVisible();
    const rows = readsSince(cursor);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toContain(expectedRequest);
    expect(rows[0].count).toBeGreaterThan(0);
    expect(rows[0].count).toBeLessThanOrEqual(6);
    if (tab === "general") await expect(page.getByRole("tabpanel", { name: "عام" }).getByText("مركز ألفا", { exact: true })).toBeVisible();
  }
  await page.getByRole("tab", { name: "الطلاب", exact: true }).click();
  await page.getByRole("tab", { name: "الحقول الإضافية", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/admin/settings?tab=student-fields`);
  await expect(page.getByRole("tab", { name: "الطلاب", exact: true })).toHaveAttribute("aria-selected", "true");
  for (const [oldPath, expected] of [
    ["/admin/security", "tab=security"],
    ["/admin/student-custom-fields?page=2", "tab=student-fields&page=2"],
    ["/admin/student-profile-choices?kind=city&q=demo&page=2", "tab=student-choices&kind=city&page=2&q=demo"],
    ["/admin/student-search?tab=settings&q=demo&page=2", "tab=students&q=demo&page=2"],
  ]) {
    await page.goto(`${origin}${oldPath}`);
    await expect(page).toHaveURL(`${origin}/admin/settings?${expected}`);
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  try {
    const ssr = await noScript.newPage();
    await ssr.goto(`${origin}/admin/settings?tab=branches`);
    await expect(ssr.getByRole("table", { name: "الفروع" })).toContainText("الفرع الشمالي");
  } finally { await noScript.close(); }
  await page.getByRole("link", { name: "Courses — الرئيسية" }).click();
  await expect(page).toHaveURL(`${origin}/admin`);
  await expect(page.locator("main").getByRole("table")).toHaveCount(0);
});

test("settings forms, account permissions and mobile RTL themes work", async ({ page, browser }) => {
  await signIn(page, "alpha");
  await page.goto(`${origin}/admin/settings?tab=general`);
  const previous = await (await page.request.get(`${origin}/api/v1/center/settings`)).json();
  const currency = previous.settings.financial_currency_locked_at ? previous.settings.financial_currency : "EGP";
  if (previous.settings.financial_currency !== currency) {
    await page.getByRole("combobox", { name: "عملة المركز" }).selectOption(currency);
    await page.getByRole("button", { name: "حفظ عملة المركز" }).click();
    await expect(page.getByRole("status").filter({ hasText: "حُفظت عملة المركز" })).toBeVisible();
  }
  const settings = await (await page.request.get(`${origin}/api/v1/center/settings`)).json();
  expect(settings.settings.financial_currency).toBe(currency);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "/tmp/courses-settings-general-desktop.png", fullPage: true });

  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 850 });
    await page.context().addCookies([{ name: "courses_theme", value: theme, url: origin }]);
    await page.goto(`${origin}/admin/settings?tab=students`);
    await expect(page.getByRole("tab", { name: "الطلاب", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
    if (width === 1440 && theme === "light") await page.screenshot({ path: "/tmp/courses-settings-hub-desktop.png", fullPage: true });
    if (width === 390 && theme === "dark") await page.screenshot({ path: "/tmp/courses-settings-hub-mobile-dark.png", fullPage: true });
  }

  const staff = await browser.newPage();
  try {
    await signIn(staff, "staff");
    await staff.goto(`${origin}/admin/settings`);
    await expect(staff.getByRole("tab", { name: "الفروع", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(staff.getByRole("tab", { name: "عام", exact: true })).toHaveCount(0);
    await expect(staff.getByRole("tab", { name: "الطلاب", exact: true })).toHaveCount(0);
    await expect(staff.getByRole("tab", { name: "أمان الحساب", exact: true })).toBeVisible();
    await staff.goto(`${origin}/admin/settings?tab=students`);
    await expect(staff.getByRole("tab", { name: "الطلاب", exact: true })).toHaveCount(0);
  } finally { await staff.close(); }
});

test("currency conflict reloads the latest revision without losing the current setting", async ({ page }) => {
  await signIn(page, "alpha");
  await page.goto(`${origin}/admin/settings?tab=general`);
  const before = (await (await page.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
  test.skip(Boolean(before.financial_currency_locked_at), "Currency is already locked by a financial movement.");
  const externalCurrency = before.financial_currency === "SAR" ? "AED" : "SAR";

  const external = await page.evaluate(async ({ currency, revision }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin" });
    const token = document.cookie.split("; ").find((part) => part.startsWith("XSRF-TOKEN="))?.slice(11);
    const response = await fetch("/api/v1/center/financial-currency", {
      method: "PATCH", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify({ currency, revision }),
    });
    return response.status;
  }, { currency: externalCurrency, revision: before.financial_currency_revision });
  expect(external).toBe(200);
  await page.getByRole("combobox", { name: "عملة المركز" }).selectOption("USD");
  await page.getByRole("button", { name: "حفظ عملة المركز" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "تغيرت عملة المركز" })).toBeVisible();
  await page.getByRole("button", { name: "تحميل أحدث إعداد للعملة" }).click();
  await expect(page.getByRole("combobox", { name: "عملة المركز" })).toHaveValue(externalCurrency);
  await page.getByRole("combobox", { name: "عملة المركز" }).selectOption("EGP");
  await page.getByRole("button", { name: "حفظ عملة المركز" }).click();
  await expect(page.getByRole("status").filter({ hasText: "حُفظت عملة المركز" })).toBeVisible();
});

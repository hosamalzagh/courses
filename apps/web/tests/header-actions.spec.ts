import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { credentials as localCredentials, ensureLocalFixtures } from './local-fixtures';

const origin = process.env.COURSES_PROFILE_TEST_ORIGIN ?? 'http://alpha.courses.test';
const fixtureFile = process.env.COURSES_PROFILE_FIXTURE_FILE;
const fixture = fixtureFile ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : undefined;

test.beforeEach(async ({ page, browser }) => {
  if (!fixture) await ensureLocalFixtures(browser);
  const account = fixture?.alpha ?? localCredentials('alpha');
  await page.goto(`${origin}/login`);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(account.email);
  await page.getByRole('textbox', { name: 'كلمة المرور' }).fill(account.password);
  await page.getByRole('button', { name: 'دخول المركز', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
});

async function headerSubmit(page: Page, label: string) {
  const button = page.locator('.center-topbar').getByRole('button', { name: label, exact: true });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('data-slot', 'button');
  const formId = await button.getAttribute('form');
  expect(formId).toBeTruthy();
  await expect(page.locator(`form[id="${formId}"]`)).toHaveCount(1);
  await expect(page.locator('#center-content').getByRole('button', { name: label, exact: true })).toHaveCount(0);
  return button;
}

test('every admin editor places submit and cancel in the shared header', async ({ page }) => {
  await page.getByRole('button', { name: 'إنشاء فرع', exact: true }).click();
  await headerSubmit(page, 'حفظ الفرع');
  await page.getByRole('textbox', { name: 'اسم الفرع', exact: true }).fill('تحقق الهيدر');
  await page.getByRole('textbox', { name: 'رمز الفرع', exact: true }).fill('INVALID SPACE');
  const response = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/branches') && response.request().method() === 'POST');
  await page.locator('.center-topbar').getByRole('button', { name: 'حفظ الفرع', exact: true }).click();
  expect((await response).status()).toBe(422);
  await expect(page.getByRole('textbox', { name: 'رمز الفرع', exact: true })).toBeFocused();
  await page.locator('.center-topbar').getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('button', { name: 'إنشاء فرع', exact: true })).toBeFocused();

  await page.goto(`${origin}/admin/instructors`);
  await page.getByRole('button', { name: 'إنشاء ملف محاضر', exact: true }).click();
  await headerSubmit(page, 'حفظ ملف المحاضر');
  await page.locator('.center-topbar').getByRole('button', { name: 'إلغاء', exact: true }).click();

  await page.goto(`${origin}/admin/curriculum`);
  await page.getByRole('button', { name: 'إنشاء كورس', exact: true }).click();
  await headerSubmit(page, 'حفظ المنهج');
  await page.locator('.center-topbar').getByRole('button', { name: 'إلغاء', exact: true }).click();

  await page.goto(`${origin}/admin/members`);
  await headerSubmit(page, 'إرسال الدعوة');
  const edit = page.getByRole('button', { name: 'تعديل الأدوار', exact: true }).first();
  if (await edit.count()) {
    await edit.click();
    await expect(page.locator('.center-topbar').getByRole('button', { name: 'حفظ الأدوار', exact: true })).toBeVisible();
    await page.locator('.center-topbar').getByRole('button', { name: 'إلغاء', exact: true }).click();
  }

  await page.goto(`${origin}/admin/settings`);
  await headerSubmit(page, 'حفظ الإعدادات');
  await headerSubmit(page, 'حفظ بداية الترقيم');

  await page.goto(`${origin}/admin/security`);
  await headerSubmit(page, 'تفعيل التحقق بخطوتين');
});

test('student form keeps header actions visible on a narrow dark screen', async ({ page }) => {
  await page.getByRole('button', { name: 'تفعيل الوضع الداكن', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/admin/students/new`);
  await headerSubmit(page, 'حفظ ملف الطالب');
  await expect(page.locator('.center-topbar').getByRole('link', { name: 'إلغاء', exact: true })).toBeVisible();
  await expect(page.locator('#student-name')).toHaveAttribute('data-slot', 'input');
  await expect(page.getByRole('checkbox').first()).toHaveAttribute('data-slot', 'checkbox');
  await expect(page.getByRole('radio').first()).toHaveAttribute('data-slot', 'radio-group-item');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator('.center-topbar').getByRole('button', { name: 'حفظ ملف الطالب', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'القائمة', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAttribute('data-slot', 'sheet-content');
  await expect(page.getByRole('button', { name: 'إغلاق القائمة', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'القائمة', exact: true })).toBeFocused();
});

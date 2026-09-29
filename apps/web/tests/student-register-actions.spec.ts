import { expect, test } from '@playwright/test';
import { credentials, signIn } from './local-fixtures';

const origin = process.env.COURSES_TEST_ORIGIN ?? 'http://alpha.courses.test';

test('student rows expose authorized actions and the profile keeps its summary first', async ({ page }, testInfo) => {
  const owner = credentials('alpha');
  await signIn(page, origin, owner.email, owner.password);
  await page.goto(`${origin}/admin/students`);

  const table = page.getByRole('table', { name: 'الطلاب في فروعي' });
  await page.getByRole('button', { name: 'الأعمدة — الطلاب في فروعي' }).click();
  const birthColumn = page.getByRole('checkbox', { name: 'تاريخ الميلاد' });
  await expect(birthColumn).not.toBeChecked();
  await birthColumn.click();
  await expect(table.getByRole('columnheader', { name: 'تاريخ الميلاد' })).toBeVisible();
  await page.getByRole('button', { name: 'إغلاق الأعمدة المعروضة — الطلاب في فروعي' }).click();
  await page.reload();
  await expect(table.getByRole('columnheader', { name: 'تاريخ الميلاد' })).toBeVisible();
  const row = table.locator('tbody tr').first();
  const actions = row.getByRole('button', { name: /^إجراءات الطالب / });
  await expect(actions).toBeVisible();
  await actions.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'عرض الملف' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'تقرير الطالب' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'تعديل البيانات' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'الحساب المالي' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toBeFocused();
  const studentName = await row.locator('h3').textContent();
  await page.getByRole('searchbox').fill(studentName!);
  await page.getByRole('searchbox').press('Enter');
  const searchRow = page.getByRole('table', { name: 'نتائج البحث' }).locator('tbody tr').first();
  await searchRow.getByRole('button', { name: /^إجراءات الطالب / }).click();
  await expect(menu.getByRole('menuitem', { name: 'تقرير الطالب' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`${origin}/admin/students`);
  const firstActions = page.getByRole('table', { name: 'الطلاب في فروعي' }).locator('tbody tr').first().getByRole('button', { name: /^إجراءات الطالب / });
  await firstActions.click();
  await menu.getByRole('menuitem', { name: 'تعديل البيانات' }).click();
  await expect(page).toHaveURL(/\/admin\/students\/[0-9a-f-]+\/edit$/);
  await expect(page.getByRole('button', { name: 'حفظ بيانات الطالب' })).toBeVisible();
  await page.goto(`${origin}/admin/students`);
  await page.getByRole('table', { name: 'الطلاب في فروعي' }).locator('tbody tr').first().getByRole('button', { name: /^إجراءات الطالب / }).click();
  await menu.getByRole('menuitem', { name: 'عرض الملف' }).click();

  await expect(page).toHaveURL(/\/admin\/students\/[0-9a-f-]+$/);
  const summary = page.getByRole('region', { name: 'ملخص الطالب' });
  const status = page.getByRole('heading', { name: /حالة ملف الطالب/ });
  await expect(summary).toBeVisible();
  await expect(status).toBeVisible();
  const summaryBox = await summary.boundingBox();
  const statusBox = await status.boundingBox();
  expect(summaryBox && statusBox).toBeTruthy();
  expect(summaryBox!.y).toBeLessThan(statusBox!.y);
  expect(summaryBox!.width).toBeLessThanOrEqual(1280);
  await expect(page.getByRole('button', { name: 'حفظ صورة الطالب' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'اختيار صورة', exact: true })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveAttribute('tabindex', '-1');
  await page.screenshot({ path: testInfo.outputPath('student-profile-desktop.png') });
  await page.screenshot({ path: testInfo.outputPath('student-profile-desktop-full.png'), fullPage: true });
  await page.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('student-profile-dark.png') });
  await page.getByRole('button', { name: 'تفعيل الوضع الفاتح' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'البيانات الشخصية', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('student-profile-mobile.png') });
  await page.screenshot({ path: testInfo.outputPath('student-profile-mobile-full.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole('tablist', { name: 'أقسام ملف الطالب' }).getByRole('tab', { name: 'الدراسة' }).click();
  await expect(page.getByRole('heading', { name: 'محاولات الدراسة' })).toBeVisible();
  await page.getByRole('tablist', { name: 'أقسام ملف الطالب' }).getByRole('tab', { name: 'الحضور والغياب' }).click();
  await expect(page.getByRole('heading', { name: 'سجل المحاضرات' })).toBeVisible();
  await page.getByRole('tablist', { name: 'أقسام ملف الطالب' }).getByRole('tab', { name: 'البيانات الشخصية' }).click();
  await expect(page.getByRole('heading', { name: 'البيانات الشخصية', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'تقرير الطالب' }).click();
  await expect(page.getByRole('article', { name: 'تقرير الطالب' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('article', { name: 'تقرير الطالب' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ملخص الغياب الحالي' })).toBeVisible();
  await expect(page.getByText('هذا العدد يخص المجموعات الحالية فقط.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('student-report-mobile.png') });
  const studentId = new URL(page.url()).pathname.split('/')[3];
  const reportData = await page.request.get(`${origin}/api/v1/center/students/${studentId}`);
  expect(reportData.ok()).toBeTruthy();
  const queryCount = reportData.headers()['x-courses-query-count'];
  expect(queryCount).toMatch(/^\d+$/);
  expect(Number(queryCount)).toBeLessThanOrEqual(6);
  console.log(`student report data SQL queries: ${queryCount}`);
  await page.evaluate(() => { window.print = () => { document.body.dataset.printed = 'yes'; }; });
  await page.getByRole('button', { name: 'طباعة التقرير' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-printed', 'yes');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.center-sidebar')).toBeHidden();
  const printedColors = await page.locator('.student-report').evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
  }));
  expect(printedColors).toEqual({ background: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' });
});

test('read-only staff do not receive edit or finance actions', async ({ page }) => {
  const staff = credentials('staff');
  await signIn(page, origin, staff.email, staff.password);
  await page.goto(`${origin}/admin/students`);
  const row = page.getByRole('table', { name: 'الطلاب في فروعي' }).locator('tbody tr').first();
  await row.getByRole('button', { name: /^إجراءات الطالب / }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'عرض الملف' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'تعديل البيانات' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'الحساب المالي' })).toHaveCount(0);
});

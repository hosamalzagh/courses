import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { credentials as localCredentials, ensureLocalFixtures, signIn } from './local-fixtures';

const origin = process.env.COURSES_PROFILE_TEST_ORIGIN ?? 'http://alpha.courses.test';
const fixtureFile = process.env.COURSES_PROFILE_FIXTURE_FILE;
const fixture = fixtureFile ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : undefined;

test.beforeEach(async ({ page, browser }) => {
  test.setTimeout(120_000);
  if (!fixture) await ensureLocalFixtures(browser);
  const account = fixture?.alpha ?? localCredentials('alpha');
  await signIn(page, origin, account.email, account.password);
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
  test.setTimeout(90_000);
  await page.goto(`${origin}/admin/settings?tab=branches`);
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
  const generalHeader = page.locator('.center-topbar');
  const contactEmail = page.getByRole('textbox', { name: 'بريد التواصل' });
  const savedEmail = await contactEmail.inputValue();
  await expect(generalHeader.getByRole('button', { name: 'حفظ الإعدادات', exact: true })).toHaveCount(0);
  await expect(generalHeader.getByRole('button', { name: 'حفظ عملة المركز', exact: true })).toHaveCount(0);
  await expect(generalHeader.getByRole('button', { name: 'إلغاء تعديل العملة', exact: true })).toHaveCount(0);
  const currency = page.getByRole('combobox', { name: 'عملة المركز' });
  if (await currency.count()) {
    const savedCurrency = await currency.inputValue();
    await currency.selectOption(savedCurrency === 'EGP' ? 'SAR' : 'EGP');
    await expect(generalHeader.getByRole('button', { name: 'حفظ عملة المركز', exact: true })).toBeVisible();
    await expect(generalHeader.getByRole('button', { name: 'إلغاء تعديل العملة', exact: true })).toHaveCount(0);
    await currency.selectOption(savedCurrency);
    await expect(generalHeader.getByRole('button', { name: 'حفظ عملة المركز', exact: true })).toHaveCount(0);
  }
  await contactEmail.fill('review@example.test');
  await headerSubmit(page, 'حفظ الإعدادات');
  await contactEmail.fill(savedEmail);
  await expect(generalHeader.getByRole('button', { name: 'حفظ الإعدادات', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'الطلاب', exact: true }).click();
  const numbering = page.getByRole('spinbutton', { name: 'بداية ترقيم الطلاب' });
  await numbering.fill(String(Number(await numbering.inputValue()) + 1));
  await headerSubmit(page, 'حفظ بداية الترقيم');
  await numbering.fill(String(Number(await numbering.inputValue()) - 1));

  await page.goto(`${origin}/admin/settings?tab=security`);
  await headerSubmit(page, 'تفعيل التحقق بخطوتين');
});

test('student settings header shows only relevant actions on desktop and mobile', async ({ page }) => {
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.context().addCookies([{ name: 'courses_theme', value: theme, url: origin }]);
    await page.goto(`${origin}/admin/settings?tab=students`);
    const header = page.locator('.center-topbar');
    await expect(header.getByRole('button', { name: /حفظ (بداية الترقيم|إعداد الفروع|إعداد الباركود الإضافي)/ })).toHaveCount(0);
    await expect(header.getByRole('button', { name: 'إجراءات البحث والمشاركة', exact: true })).toHaveCount(0);
    const toggle = page.getByRole('checkbox', { name: 'تفعيل البحث بين الفروع', exact: true });
    await expect(toggle).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'السماح بمشاركة الملفات الجديدة', exact: true })).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('alertdialog', { name: 'تفعيل البحث بين الفروع' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByRole('tablist', { name: 'أقسام الإعدادات' }).getByRole('tab', { name: 'الحقول الإضافية' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'إعدادات الطلاب', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'الحقول الإضافية', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/admin/settings?tab=student-fields`);
    await expect(page.getByRole('tab', { name: 'الطلاب', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'قوائم بيانات الطالب', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/admin/settings?tab=student-choices`);
    await page.getByRole('tab', { name: 'إعدادات الطلاب', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/admin/settings?tab=students`);

    const numbering = page.getByRole('spinbutton', { name: 'بداية ترقيم الطلاب' });
    const original = await numbering.inputValue();
    await numbering.fill(String(Number(original) + 1));
    await headerSubmit(page, 'حفظ بداية الترقيم');
    await numbering.fill(original);
    await expect(numbering).toHaveValue(original);
    await expect(header.getByRole('button', { name: 'حفظ بداية الترقيم', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('unsaved branch setting blocks browser Back while the code setting is clean', async ({ page }) => {
  await page.getByRole('link', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('tab', { name: 'الطلاب', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: 'ربط كل ملف طالب جديد بجميع فروع المركز', exact: true });
  const original = await checkbox.isChecked();
  await checkbox.click();
  await expect(page.locator('.center-topbar').getByRole('button', { name: 'حفظ إعداد الفروع', exact: true })).toBeVisible();

  await page.evaluate(() => window.history.back());
  const confirmation = page.getByRole('alertdialog', { name: 'مغادرة دون حفظ' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/admin/settings?tab=students`);
  await expect(checkbox).toBeChecked({ checked: !original });

  await checkbox.click();
  const codeLabel = page.getByRole('textbox', { name: 'اسم الباركود الإضافي', exact: true });
  const draft = `${await codeLabel.inputValue()} مسودة`;
  await codeLabel.fill(draft);
  await page.evaluate(() => window.history.back());
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(codeLabel).toHaveValue(draft);
});

test('student form keeps header actions visible on a narrow dark screen', async ({ page }) => {
  await page.getByRole('button', { name: 'تفعيل الوضع الداكن', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/admin/students/new`);
  await headerSubmit(page, 'حفظ ملف الطالب');
  await expect(page.locator('.center-topbar').getByRole('link', { name: 'إلغاء', exact: true })).toBeVisible();
  await expect(page.locator('#student-name')).toHaveAttribute('data-slot', 'input');
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  if (workspace.student_branch_settings.enabled) {
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'الفروع' })).toHaveCount(0);
  } else {
    await expect(page.getByRole('checkbox').first()).toHaveAttribute('data-slot', 'checkbox');
  }
  await expect(page.getByRole('radio').first()).toHaveAttribute('data-slot', 'radio-group-item');
  await page.getByRole('textbox', { name: 'تاريخ الميلاد', exact: true }).fill('2020-09-15');
  await page.getByRole('button', { name: 'اختيار تاريخ الميلاد', exact: true }).click();
  const datePicker = page.getByRole('dialog', { name: 'اختيار تاريخ الميلاد' });
  await expect(datePicker).toBeVisible();
  await expect(datePicker.locator('select').first().locator('option:checked')).toHaveText('سبتمبر');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator('.center-topbar').getByRole('button', { name: 'حفظ ملف الطالب', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'القائمة', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'مركز ألفا' })).toHaveAttribute('data-slot', 'sheet-content');
  await expect(page.getByRole('button', { name: 'إغلاق القائمة', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'القائمة', exact: true })).toBeFocused();
});

test('center-wide student linking updates the owner creation form', async ({ page }) => {
  const settingsResponse = await page.request.get(`${origin}/api/v1/center/user?include=student-settings`);
  expect(settingsResponse.ok()).toBe(true);
  const original = Boolean((await settingsResponse.json()).settings.student_all_branches_enabled);
  const settingName = 'ربط كل ملف طالب جديد بجميع فروع المركز';

  async function setBranchLinking(enabled: boolean) {
    await page.goto(`${origin}/admin/settings?tab=students`);
    const checkbox = page.getByRole('checkbox', { name: settingName, exact: true });
    await expect(checkbox).toBeVisible();
    if ((await checkbox.isChecked()) !== enabled) {
      await checkbox.click();
      const save = page.locator('.center-topbar').getByRole('button', { name: 'حفظ إعداد الفروع', exact: true });
      await save.click();
      await expect(save).toHaveCount(0);
      await expect(checkbox).toBeChecked({ checked: enabled });
      await expect.poll(async () => Boolean((await (await page.request.get(`${origin}/api/v1/center/user?include=student-settings`)).json()).settings.student_all_branches_enabled)).toBe(enabled);
    }
  }

  try {
    await setBranchLinking(!original);
    await page.goto(`${origin}/admin/students/new`);
    await expect(page.getByRole('region', { name: 'الفروع', exact: true })).toHaveCount(original ? 1 : 0);
    await expect(page.locator('.center-topbar').getByRole('button', { name: 'حفظ ملف الطالب', exact: true })).toBeVisible();
    await page.goto(`${origin}/admin/audit`);
    const change = page.getByRole('row').filter({ hasText: 'تغيير ربط ملفات الطلاب الجديدة بالفروع' }).first();
    await expect(change).toBeVisible();
    await change.getByText('عرض تغيير ربط الفروع', { exact: true }).click();
    await expect(change.getByText(`قبل التغيير: ${original ? 'مفعّل' : 'مغلق'}`, { exact: true })).toBeVisible();
    await expect(change.getByText(`بعد التغيير: ${original ? 'مغلق' : 'مفعّل'}`, { exact: true })).toBeVisible();
  } finally {
    await setBranchLinking(original);
  }
});

test('student creation recovers a changed branch setting without losing entered data', async ({ page }) => {
  await page.goto(`${origin}/admin/students/new`);
  const workspaceResponse = await page.request.get(`${origin}/api/v1/center/student-workspace`);
  expect(workspaceResponse.ok()).toBe(true);
  const workspace = await workspaceResponse.json();
  const latest = {
    ...workspace,
    student_branch_settings: {
      enabled: !workspace.student_branch_settings.enabled,
      revision: workspace.student_branch_settings.revision + 1,
    },
  };
  let workspaceUnavailable = true;
  await page.route('**/api/v1/center/student-workspace', (route) => route.fulfill({
    status: workspaceUnavailable ? 500 : 200,
    contentType: 'application/json',
    body: JSON.stringify(workspaceUnavailable ? { message: 'Unavailable' } : latest),
  }));
  await page.route('**/api/v1/center/students/similar?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ students: [] }) }));
  await page.route('**/api/v1/center/students', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'student_branch_settings_changed' }) }));

  const name = `طالب تعارض الفروع ${Date.now()}`;
  const nameInput = page.getByRole('textbox', { name: 'اسم الطالب', exact: true });
  await nameInput.fill(name);
  const requiredSku = page.getByRole('textbox', { name: 'sku', exact: true });
  if (await requiredSku.count()) await requiredSku.fill(`SKU-${Date.now()}`);
  await page.locator('.center-topbar').getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  await expect(page.getByText(/تعذر تحميل أحدث إعداد/)).toBeVisible();
  await expect(nameInput).toHaveValue(name);

  workspaceUnavailable = false;
  await page.locator('.center-topbar').getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  await expect(page.getByText(/راجع اختيار الفروع ثم احفظ مرة أخرى/)).toBeVisible();
  await expect(nameInput).toHaveValue(name);
  await expect(page.getByRole('region', { name: 'الفروع', exact: true })).toHaveCount(latest.student_branch_settings.enabled ? 0 : 1);
});

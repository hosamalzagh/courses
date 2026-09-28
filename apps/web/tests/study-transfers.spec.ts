import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

test.skip(!process.env.COURSES_TRANSFER_CREDENTIALS || !process.env.COURSES_TRANSFER_QUERY_LOG,
  'Requires the disposable transfer center and SSR query log.');
test.setTimeout(120_000);
const origin = process.env.COURSES_TRANSFER_ORIGIN ?? 'http://alpha.courses.test:8658';
const credentials = process.env.COURSES_TRANSFER_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_TRANSFER_CREDENTIALS, 'utf8')) : {};

async function signIn(page: Page, who: 'alpha' | 'staff') {
  await page.goto(`${origin}/login`);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(credentials[who].email);
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).fill(credentials[who].password);
  await page.getByRole('button', { name: 'دخول المركز', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, route: string, payload: object, method = 'POST') {
  return page.evaluate(async ({ route, payload, method }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find(part => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

function queryRows() {
  const path = process.env.COURSES_TRANSFER_QUERY_LOG!;
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { path: string; count: number | null }) : [];
}

test('moves an active attempt across branches with a reviewed preview and denies another employee', async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, 'alpha');
    const stamp = Date.now();
    async function group(branchId: number, label: string) {
      const course = await write(owner, 'courses', { branch_id: branchId, name: `Course ${label} ${stamp}`, request_id: crypto.randomUUID() });
      expect(course.status).toBe(201);
      const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: 'Stage', request_id: crypto.randomUUID() });
      expect(stage.status).toBe(201);
      const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: `Level ${label}`,
        lectures: [{ number: 1, content: `Lecture ${label}`, planned_hours: 1 }], request_id: crypto.randomUUID() });
      expect(level.status).toBe(201);
      const instructor = await write(owner, 'instructors', { name: `Teacher ${label} ${stamp}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
      expect(instructor.status).toBe(201);
      const created = await write(owner, 'groups', { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
        name: `Group ${label} ${stamp}`, approved_price: '100.00', instructor_ids: [instructor.body.instructor.id],
        request_id: crypto.randomUUID() });
      expect(created.status).toBe(201);
      return { group: created.body.group, plan: level.body.level.plan };
    }
    const north = await write(owner, 'branches', { name: `Transfer north ${stamp}`, slug: `transfer-n-${stamp}` });
    const south = await write(owner, 'branches', { name: `Transfer south ${stamp}`, slug: `transfer-s-${stamp}` });
    expect(north.status).toBe(201); expect(south.status).toBe(201);
    const source = await group(north.body.branch.id, 'source');
    const target = await group(south.body.branch.id, 'target');
    const student = await write(owner, 'students', { name: `طالب نقل ${stamp}`, branch_ids: [north.body.branch.id, south.body.branch.id], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const studentId = student.body.student.id;
    const account = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
    if (!account.account.currency) {
      expect((await write(owner, 'financial-currency', { currency: 'EGP', revision: account.account.currency_revision }, 'PATCH')).status).toBe(200);
    }
    const enrollments = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
    const enrolled = await write(owner, `students/${studentId}/enrollments`, {
      group_id: source.group.id, group_revision: source.group.revision,
      currency_revision: enrollments.student.currency_revision, joined_on: '2026-09-27',
      discount: '0.00', discount_reason: null, version: enrollments.student.version, request_id: crypto.randomUUID(),
    });
    expect(enrolled.status).toBe(201);
    const attemptId = enrolled.body.attempt.id;
    const approval = await write(owner, 'content-equivalences', {
      source_plan_version_id: source.plan.id, target_plan_version_id: target.plan.id,
      source_lecture_ids: [source.plan.lectures[0].id], target_lecture_ids: [target.plan.lectures[0].id],
      reason: 'معادلة معتمدة لرحلة النقل', request_id: crypto.randomUUID(),
    });
    expect(approval.status).toBe(201);
    const start = queryRows().length;
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`${origin}/admin/students/${studentId}/enrollments`);
    await expect(owner.getByRole('table', { name: 'محاولات الدراسة' })).toBeVisible();
    expect(await owner.locator('html').getAttribute('dir')).toBe('rtl');
    const reads = queryRows().slice(start).filter(row => row.path.startsWith('/api/v1/center/'));
    expect(reads.reduce((sum, row) => sum + (row.count ?? 0), 0)).toBeLessThanOrEqual(6);
    await owner.locator(`[id$="-transfer-${attemptId}"]`).click();
    const editor = owner.getByRole('region', { name: 'نقل الطالب بين المجموعات والفروع' });
    await expect(editor).toBeVisible();
    await owner.getByRole('button', { name: 'القائمة' }).click();
    await owner.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
    await expect(owner.locator('html')).toHaveAttribute('data-theme', 'dark');
    await owner.getByRole('button', { name: 'إغلاق القائمة' }).click();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await editor.getByLabel('مجموعة الوجهة').selectOption(target.group.id);
    await editor.getByLabel('تاريخ النقل الفعلي').fill('2026-09-29');
    const previewResponse = owner.waitForResponse(response => response.request().method() === 'GET'
      && response.url().includes(`/enrollments/${attemptId}/transfer/preview?`));
    await owner.getByRole('button', { name: 'معاينة النقل' }).click();
    expect(Number((await previewResponse).headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    await expect(editor.getByText(/متطلبات الوجهة: ١، المحتسب: ٠، الناقص: ١/)).toBeVisible();
    await expect(editor.getByText(/مديونية الفروع المصرح بها/)).toBeVisible();
    await editor.getByLabel('سبب النقل').fill('انتقل إلى الفرع الجنوبي');
    await owner.getByRole('button', { name: 'تأكيد النقل' }).click();
    await expect(owner.getByRole('alertdialog')).toBeVisible();
    await owner.getByRole('button', { name: 'نقل المحاولة' }).click();
    await expect(owner.getByText('حُفظ النقل في المحاولة نفسها دون رسوم أو تخصيص جديد.')).toBeVisible();
    await expect(owner.locator(`[id$="-transfer-${attemptId}"]`)).toBeFocused();
    const current = await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`);
    expect(Number(current.headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    expect((await current.json()).attempts[0]).toMatchObject({ id: attemptId, branch_id: south.body.branch.id,
      current_group_id: target.group.id, fee: { net_amount: '100.00' } });
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText('نقل محاولة الدراسة بين المجموعات أو الفروع').first()).toBeVisible();
    await owner.getByText('تفاصيل نقل محاولة الدراسة').first().click();
    await expect(owner.getByText(/انتقل إلى الفرع الجنوبي/).first()).toBeVisible();
    await signIn(staff, 'staff');
    expect((await staff.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).status()).toBe(404);
    expect((await staff.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments/${attemptId}/transfer/preview?group_id=${source.group.id}&transferred_on=2026-09-29`)).status()).toBe(404);
  } finally { await owner.close(); await staff.close(); }
});

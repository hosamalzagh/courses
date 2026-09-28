import { expect, test, type Page, type Route } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

test.skip(!process.env.COURSES_PLAN_CREDENTIALS || !process.env.COURSES_PLAN_QUERY_LOG,
  'Requires the disposable equivalence center and SSR query log.');
test.setTimeout(120_000);
const origin = process.env.COURSES_PLAN_ORIGIN ?? 'http://alpha.courses.test:8658';
const credentials = process.env.COURSES_PLAN_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_PLAN_CREDENTIALS, 'utf8')) : {};

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
  const path = process.env.COURSES_PLAN_QUERY_LOG!;
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { path: string; count: number | null }) : [];
}

test('whole-lecture equivalence approval is scoped, auditable and recoverable', async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, 'alpha');
    const stamp = Date.now();
    const firstReason = `مراجعة أكاديمية تؤكد استيفاء المحاضرتين المستهدفتين كاملتين ${stamp}.`;
    async function plan(branchId: number, name: string) {
      const course = await write(owner, 'courses', { branch_id: branchId, name, request_id: crypto.randomUUID() });
      expect(course.status).toBe(201);
      const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: 'مرحلة', request_id: crypto.randomUUID() });
      expect(stage.status).toBe(201);
      const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name,
        request_id: crypto.randomUUID(), lectures: [
          { number: 1, content: 'محتوى أول', planned_hours: 1 },
          { number: 2, content: 'محتوى ثان', planned_hours: 2 },
        ] });
      expect(level.status).toBe(201);
      return level.body.level as { id: string; plan: { id: string; lectures: { id: string }[] } };
    }
    const firstBranch = await write(owner, 'branches', { name: `فرع مصدر ${stamp}`, slug: `eq-source-${stamp}` });
    const secondBranch = await write(owner, 'branches', { name: `فرع وجهة ${stamp}`, slug: `eq-target-${stamp}` });
    expect(firstBranch.status).toBe(201); expect(secondBranch.status).toBe(201);
    const source = await plan(firstBranch.body.branch.id, `مصدر المعادلة ${stamp}`);
    const target = await plan(secondBranch.body.branch.id, `وجهة المعادلة ${stamp}`);
    const start = queryRows().length;
    await owner.goto(`${origin}/admin/equivalences`);
    await expect(owner.getByRole('heading', { name: 'معادلة المحتوى', exact: true })).toBeVisible();
    const reads = queryRows().slice(start).filter(row => row.path.startsWith('/api/v1/center/'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(row => Number.isInteger(row.count) && row.count! >= 0)).toBe(true);
    expect(reads.reduce((sum, row) => sum + row.count!, 0)).toBeLessThanOrEqual(6);
    await owner.getByRole('button', { name: 'اعتماد معادلة محتوى' }).click();
    await expect(owner.getByLabel('إصدار المصدر')).toBeFocused();
    await owner.getByLabel('إصدار المصدر').selectOption(source.plan.id);
    await owner.getByLabel('إصدار المتطلبات المستهدفة').selectOption(target.plan.id);
    const sourceChoices = owner.getByRole('group', { name: 'محاضرات المصدر المطلوبة كلها' });
    const targetChoices = owner.getByRole('group', { name: 'المتطلبات المستهدفة كاملة' });
    await owner.getByLabel('سبب الاعتماد').fill(firstReason);
    await owner.getByRole('button', { name: 'اعتماد المعادلة' }).click();
    await expect(sourceChoices.getByRole('checkbox').first()).toBeFocused();
    await sourceChoices.getByRole('checkbox').first().click();
    await owner.getByRole('button', { name: 'اعتماد المعادلة' }).click();
    await expect(targetChoices.getByRole('checkbox').first()).toBeFocused();
    await targetChoices.getByRole('checkbox').first().click();
    await targetChoices.getByRole('checkbox').nth(1).click();
    const savedResponse = owner.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith('/content-equivalences'));
    await owner.getByRole('button', { name: 'اعتماد المعادلة' }).click();
    expect((await savedResponse).status()).toBe(201);
    await expect(owner.getByText('اعتُمدت المعادلة بين محاضرات كاملة.')).toBeVisible();
    await expect(owner.getByRole('table', { name: 'سجل اعتمادات معادلة المحتوى' })
      .getByText(firstReason)).toBeVisible();
    await owner.getByRole('table', { name: 'سجل اعتمادات معادلة المحتوى' })
      .getByText('عرض المحاضرات المعتمدة').first().click();
    await expect(owner.getByRole('table', { name: 'سجل اعتمادات معادلة المحتوى' }).getByText('محتوى أول').first()).toBeVisible();
    const attemptedRewrite = await write(owner, `levels/${source.id}/first-plan`, { revision: 1,
      plan_version_id: source.plan.id, lectures: [{ number: 1, content: 'تغيير بعد الاعتماد', planned_hours: 1 }] }, 'PATCH');
    expect(attemptedRewrite.status).toBe(409);
    expect(attemptedRewrite.body.code).toBe('plan_used');
    await owner.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
    await expect(owner.locator('html')).toHaveAttribute('data-theme', 'dark');
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const members = await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json();
    const memberId = members.members.find((member: { user: { email: string } }) => member.user.email === credentials.staff.email)?.id;
    expect(memberId).toBeTruthy();
    const grant = (roles: Record<number, string[]>) => write(owner, `members/${memberId}/grants`, { center_roles: [], branch_roles: roles }, 'PUT');
    expect((await grant({ [firstBranch.body.branch.id]: ['branch_viewer'], [secondBranch.body.branch.id]: ['branch_viewer'] })).status).toBe(200);
    await signIn(staff, 'staff');
    await staff.goto(`${origin}/admin/equivalences`);
    await expect(staff.getByRole('button', { name: 'اعتماد معادلة محتوى' })).toHaveCount(0);
    await expect(staff.getByRole('table', { name: 'سجل اعتمادات معادلة المحتوى' }).getByText(firstReason)).toBeVisible();
    const request = { source_plan_version_id: source.plan.id, target_plan_version_id: target.plan.id,
      source_lecture_ids: [source.plan.lectures[1].id], target_lecture_ids: [target.plan.lectures[1].id],
      reason: 'مراجعة معادلة جديدة', request_id: crypto.randomUUID() };
    expect((await write(staff, 'content-equivalences', request)).status).toBe(403);
    expect((await grant({ [firstBranch.body.branch.id]: ['academic_admin'], [secondBranch.body.branch.id]: ['academic_admin'] })).status).toBe(200);
    await staff.reload();
    await staff.getByRole('button', { name: 'اعتماد معادلة محتوى' }).click();
    await staff.getByLabel('إصدار المصدر').selectOption(source.plan.id);
    await staff.getByLabel('إصدار المتطلبات المستهدفة').selectOption(target.plan.id);
    await staff.getByRole('group', { name: 'محاضرات المصدر المطلوبة كلها' }).getByRole('checkbox').nth(1).click();
    await staff.getByRole('group', { name: 'المتطلبات المستهدفة كاملة' }).getByRole('checkbox').nth(1).click();
    await staff.getByLabel('سبب الاعتماد').fill('سبب صالح لكنه سيفقد الصلاحية');
    expect((await grant({ [firstBranch.body.branch.id]: ['academic_admin'], [secondBranch.body.branch.id]: ['branch_viewer'] })).status).toBe(200);
    await staff.getByRole('button', { name: 'اعتماد المعادلة' }).click();
    await expect(staff.getByRole('alert').filter({ hasText: 'خارج صلاحيتك' })).toBeVisible();
    await staff.getByRole('button', { name: 'إلغاء' }).click();
    expect((await grant({ [firstBranch.body.branch.id]: ['academic_admin'], [secondBranch.body.branch.id]: ['academic_admin'] })).status).toBe(200);
    await staff.reload();
    await staff.getByRole('button', { name: 'اعتماد معادلة محتوى' }).click();
    await staff.getByLabel('إصدار المصدر').selectOption(source.plan.id);
    await staff.getByLabel('إصدار المتطلبات المستهدفة').selectOption(target.plan.id);
    await staff.getByRole('group', { name: 'محاضرات المصدر المطلوبة كلها' }).getByRole('checkbox').nth(0).click();
    await staff.getByRole('group', { name: 'محاضرات المصدر المطلوبة كلها' }).getByRole('checkbox').nth(1).click();
    await staff.getByRole('group', { name: 'المتطلبات المستهدفة كاملة' }).getByRole('checkbox').nth(0).click();
    await staff.getByLabel('سبب الاعتماد').fill('اعتماد مع تأخر الرد ثم سحب الصلاحية');
    const staffLostResponse = async (route: Route) => { await route.fetch(); await route.abort(); };
    await staff.route('**/api/v1/center/content-equivalences', staffLostResponse);
    await staff.getByRole('button', { name: 'اعتماد المعادلة' }).click();
    await expect(staff.getByRole('button', { name: 'التحقق من الحفظ' })).toBeVisible();
    await staff.unroute('**/api/v1/center/content-equivalences', staffLostResponse);
    expect((await grant({ [firstBranch.body.branch.id]: ['academic_admin'], [secondBranch.body.branch.id]: ['branch_viewer'] })).status).toBe(200);
    await staff.getByRole('button', { name: 'التحقق من الحفظ' }).click();
    await expect(staff.getByRole('alert').filter({ hasText: 'خارج صلاحيتك' })).toBeVisible();
    await expect(staff.getByRole('button', { name: 'اعتماد المعادلة' })).toBeVisible();
    await staff.getByRole('button', { name: 'إلغاء' }).click();
    await owner.goto(`${origin}/admin/equivalences`);
    await owner.getByRole('button', { name: 'اعتماد معادلة محتوى' }).click();
    await owner.getByLabel('إصدار المصدر').selectOption(source.plan.id);
    await owner.getByLabel('إصدار المتطلبات المستهدفة').selectOption(target.plan.id);
    await owner.getByRole('group', { name: 'محاضرات المصدر المطلوبة كلها' }).getByRole('checkbox').nth(1).click();
    await owner.getByRole('group', { name: 'المتطلبات المستهدفة كاملة' }).getByRole('checkbox').nth(1).click();
    await owner.getByLabel('سبب الاعتماد').fill('معادلة ثانية مع تعطل رد الحفظ');
    const loseResponse = async (route: Route) => { await route.fetch(); await route.abort(); };
    await owner.route('**/api/v1/center/content-equivalences', loseResponse);
    await owner.getByRole('button', { name: 'اعتماد المعادلة' }).click();
    await expect(owner.getByRole('button', { name: 'التحقق من الحفظ' })).toBeVisible();
    await owner.unroute('**/api/v1/center/content-equivalences', loseResponse);
    await owner.getByRole('button', { name: 'التحقق من الحفظ' }).click();
    await expect(owner.getByText('اعتُمدت المعادلة بين محاضرات كاملة.')).toBeVisible();
    const race = { source_plan_version_id: source.plan.id, target_plan_version_id: target.plan.id,
      source_lecture_ids: [source.plan.lectures[1].id], target_lecture_ids: [target.plan.lectures[0].id],
      reason: 'سباق طلبين لاعتماد المحتوى نفسه' };
    const outcomes = await Promise.all([
      write(owner, 'content-equivalences', { ...race, request_id: crypto.randomUUID() }),
      write(owner, 'content-equivalences', { ...race, request_id: crypto.randomUUID() }),
    ]);
    expect(outcomes.map(result => result.status).sort()).toEqual([201, 409]);
    const approvals = await (await owner.request.get(`${origin}/api/v1/center/content-equivalences`)).json();
    expect(approvals.approvals.filter((approval: { source_lecture_ids: string[]; target_lecture_ids: string[] }) =>
      approval.source_lecture_ids.length === 1
      && approval.source_lecture_ids.includes(source.plan.lectures[1].id)
      && approval.target_lecture_ids.length === 1
      && approval.target_lecture_ids.includes(target.plan.lectures[0].id))).toHaveLength(1);
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText('اعتماد معادلة المحتوى').first()).toBeVisible();
    await owner.getByText('عرض اعتماد معادلة المحتوى').first().click();
    await expect(owner.getByText('سبب الاعتماد:').first()).toBeVisible();
  } finally {
    await owner.close(); await staff.close();
  }
});

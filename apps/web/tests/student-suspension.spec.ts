import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const host = process.env.COURSES_ISSUE68_BROWSER_URL;
const credentialsFile = path.resolve(process.cwd(), '../api/storage/app/private/issue68-browser-credentials.json');
test.setTimeout(90_000);
test.skip(!host, 'Use the isolated issue68 fixture, database, and browser URL.');
const ownerHost = host ?? 'http://alpha.courses.test:8268';
const betaHost = ownerHost.replace('alpha.', 'beta.');
const credentials = () => JSON.parse(readFileSync(credentialsFile, 'utf8')) as Record<'owner' | 'staff', { email: string; password: string; id: number }>;

async function signIn(page: Page, role: 'owner' | 'staff', url = ownerHost) {
  const user = credentials()[role];
  await page.goto(`${url}/login`);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(user.email);
  await page.getByRole('textbox', { name: 'كلمة المرور' }).fill(user.password);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'دخول المركز' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(`${url}/admin`);
}
async function write(page: Page, route: string, method: string, payload: object) {
  return page.evaluate(async ({ route, method, payload }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin' });
    const csrf = document.cookie.split('; ').find((part) => part.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '';
    const response = await fetch(`/api/v1/center/${route}`, { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(csrf) }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
}
async function createStudent(page: Page) {
  const workspace = await (await page.request.get(`${ownerHost}/api/v1/center/student-workspace`)).json();
  const result = await write(page, 'students', 'POST', { name: `طالب الإيقاف ${Date.now()}`, branch_ids: [workspace.branches[0].id], request_id: crypto.randomUUID() });
  expect(result.status).toBe(201);
  return result.body.student;
}
async function changeThroughForm(page: Page, label: string, reason: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'سبب تغيير الحالة' })).toBeFocused();
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'سبب تغيير الحالة' })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'سبب تغيير الحالة' }).fill(reason);
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('alertdialog').getByRole('button', { name: 'إلغاء', exact: true })).toBeFocused();
  await page.getByRole('alertdialog').getByRole('button', { name: label, exact: true }).click();
}

test('owner suspends and lifts with visible periods, confirmation, RTL, themes and preserved general data', async ({ page }) => {
  await signIn(page, 'owner');
  const student = await createStudent(page);
  await page.goto(`${ownerHost}/admin/students/${student.id}`);
  await expect(page.getByText('لا توجد فترات إيقاف مسجلة.')).toBeVisible();
  await changeThroughForm(page, 'إيقاف ملف الطالب', 'قبول إيقاف بسبب مسجل');
  await expect(page.getByRole('heading', { name: 'حالة ملف الطالب: موقوف' })).toBeVisible();
  await expect(page.getByText('السبب: قبول إيقاف بسبب مسجل', { exact: true })).toBeVisible();
  await expect(page.getByText('الإيقاف مستمر', { exact: true })).toBeVisible();
  const edited = await write(page, `students/${student.id}`, 'PATCH', { name: `${student.name} معدل`, branch_ids: [], revision: 1 });
  expect(edited.status).toBe(200); expect(edited.body.student.status).toBe('suspended');
  expect(edited.body.student.student_number).toBe(student.student_number);
  await page.reload();
  await page.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await changeThroughForm(page, 'فك إيقاف ملف الطالب', 'قبول فك الإيقاف');
  await expect(page.getByRole('heading', { name: 'حالة ملف الطالب: نشط' })).toBeVisible();
  await expect(page.getByText('السبب: قبول فك الإيقاف', { exact: true })).toBeVisible();
  await expect(page.getByText('السبب: قبول إيقاف بسبب مسجل', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/courses-issue68-mobile-dark.png', fullPage: true });
  await page.goto(`${ownerHost}/admin/audit`);
  await page.getByText('عرض تغيير حالة الطالب', { exact: true }).first().click();
  await expect(page.locator('details[open]').getByText('السبب: قبول فك الإيقاف', { exact: true })).toBeVisible();
});

test('parallel requests, stale revision, cross center access, revoked administrator, and CSRF cannot bypass status decisions', async ({ browser }) => {
  const owner = await browser.newPage(); const staff = await browser.newPage(); const beta = await browser.newPage();
  try {
    await signIn(owner, 'owner'); const student = await createStudent(owner);
    const route = `students/${student.id}/status`;
    const decision = { status: 'suspended', reason: 'Concurrent decision', status_revision: 1, request_id: crypto.randomUUID() };
    const duplicates = await Promise.all([write(owner, route, 'POST', decision), write(owner, route, 'POST', decision)]);
    expect(duplicates.map((r) => r.status)).toEqual([200, 200]);
    let context = await (await owner.request.get(`${ownerHost}/api/v1/center/students/${student.id}`)).json();
    expect(context.suspensions).toHaveLength(1);
    const lift = { status: 'active', reason: 'Lift race', status_revision: 2 };
    const competing = await Promise.all([write(owner, route, 'POST', { ...lift, request_id: crypto.randomUUID() }), write(owner, route, 'POST', { ...lift, request_id: crypto.randomUUID() })]);
    expect(competing.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await write(owner, route, 'POST', decision)).status).toBe(409);
    const noCsrf = await owner.request.post(`${ownerHost}/api/v1/center/${route}`, { data: { ...decision, status_revision: 3 } });
    expect(noCsrf.status()).toBe(419);
    await signIn(staff, 'staff'); await staff.goto(`${ownerHost}/admin/students/${student.id}`);
    await expect(staff.getByText('تغيير الحالة متاح لمالك المركز ومسؤول المركز فقط.')).toBeVisible();
    expect((await write(staff, route, 'POST', { ...decision, status_revision: 3 })).status).toBe(403);
    await signIn(beta, 'owner', betaHost);
    expect((await write(beta, route, 'POST', { ...decision, status_revision: 3 })).status).toBe(404);
    const members = await (await owner.request.get(`${ownerHost}/api/v1/center/member-workspace`)).json();
    const member = members.members.find((entry: { user: { id: number } }) => entry.user.id === credentials().staff.id);
    expect((await write(owner, `members/${member.id}/grants`, 'PUT', { center_roles: ['center_admin'], branch_roles: member.branch_roles })).status).toBe(200);
    await staff.reload(); await staff.getByRole('button', { name: 'إيقاف ملف الطالب', exact: true }).click();
    await staff.getByRole('textbox', { name: 'سبب تغيير الحالة' }).fill('Open stale administrator form');
    expect((await write(owner, `members/${member.id}/grants`, 'PUT', { center_roles: [], branch_roles: member.branch_roles })).status).toBe(200);
    await staff.getByRole('button', { name: 'إيقاف ملف الطالب', exact: true }).click();
    await staff.getByRole('alertdialog').getByRole('button', { name: 'إيقاف ملف الطالب', exact: true }).click();
    await expect(staff.getByRole('alert')).toBeVisible();
    context = await (await owner.request.get(`${ownerHost}/api/v1/center/students/${student.id}`)).json();
    expect(context.students[0].status).toBe('active'); expect(context.suspensions).toHaveLength(1);
  } finally { await owner.close(); await staff.close(); await beta.close(); }
});

test('lost response retries one decision and stale forms recover by loading the current state', async ({ page }) => {
  await signIn(page, 'owner'); const student = await createStudent(page);
  await page.goto(`${ownerHost}/admin/students/${student.id}`);
  await page.route(`**/api/v1/center/students/${student.id}/status`, async route => { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('connectionclosed'); }, { times: 1 });
  await changeThroughForm(page, 'إيقاف ملف الطالب', 'Response lost');
  await expect(page.getByRole('alert').filter({ hasText: 'تعذر تأكيد تغيير الحالة' })).toBeVisible();
  await page.getByRole('button', { name: 'إيقاف ملف الطالب', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'إيقاف ملف الطالب', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'حالة ملف الطالب: موقوف' })).toBeVisible();
  await page.getByRole('button', { name: 'فك إيقاف ملف الطالب', exact: true }).click();
  await page.getByRole('textbox', { name: 'سبب تغيير الحالة' }).fill('Stale lift');
  expect((await write(page, `students/${student.id}/status`, 'POST', { status: 'active', reason: 'Other staff decision', status_revision: 2, request_id: crypto.randomUUID() })).status).toBe(200);
  await page.getByRole('button', { name: 'فك إيقاف ملف الطالب', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'فك إيقاف ملف الطالب', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت حالة الملف' })).toBeVisible();
  await page.getByRole('button', { name: 'تحميل أحدث حالة الطالب' }).click();
  await expect(page.getByRole('form', { name: 'إيقاف ملف الطالب', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('button', { name: 'إيقاف ملف الطالب', exact: true })).toBeFocused();
});


test('short and long history loads and pagination stay within six measured queries including SSR', async ({ page }) => {
  await signIn(page, 'owner'); const student = await createStudent(page);
  const logFile = process.env.COURSES_ISSUE68_QUERY_LOG ?? '/tmp/courses-issue68-requests.jsonl';
  const log = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { path: string; count: string | null });
  async function budget(url: string) {
    const cursor = log().length;
    await page.goto(url);
    await expect(page.getByRole('heading', { name: /^حالة ملف الطالب:/ })).toBeVisible();
    const reads = log().slice(cursor).filter(entry => entry.path.startsWith('/api/v1/center/'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(entry => entry.count !== null && Number(entry.count) > 0)).toBe(true);
    const total = reads.reduce((sum, entry) => sum + Number(entry.count), 0);
    expect(total).toBeLessThanOrEqual(6);
    console.log(`issue68 page SQL count=${total}`);
  }
  await budget(`${ownerHost}/admin/students/${student.id}`);
  await budget(`${ownerHost}/admin/students/${student.id}`);
  for (let revision = 1; revision <= 42; revision++) {
    expect((await write(page, `students/${student.id}/status`, 'POST', { status: revision % 2 ? 'suspended' : 'active', reason: `Long history ${revision}`, status_revision: revision, request_id: crypto.randomUUID() })).status).toBe(200);
  }
  await budget(`${ownerHost}/admin/students/${student.id}`);
  await expect(page.getByRole('link', { name: 'الفترات الأقدم' })).toBeVisible();
  const cursor = log().length;
  await page.getByRole('link', { name: 'الفترات الأقدم' }).click();
  await expect(page).toHaveURL(/status_page=2/);
  await expect(page.getByText('السبب: Long history 1', { exact: true })).toBeVisible();
  const reads = log().slice(cursor).filter(entry => entry.path.startsWith('/api/v1/center/'));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every(entry => entry.count !== null && Number(entry.count) > 0)).toBe(true);
  expect(reads.reduce((sum, entry) => sum + Number(entry.count), 0)).toBeLessThanOrEqual(6);
  const context = await (await page.request.get(`${ownerHost}/api/v1/center/students/${student.id}`)).json();
  expect(context.suspensions).toHaveLength(20); expect(context.status_pagination.has_more).toBe(true);
});

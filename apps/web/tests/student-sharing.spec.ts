import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const host = process.env.COURSES_SHARING_HOST ?? 'http://issue67-alpha.courses.test';
const betaHost = process.env.COURSES_SHARING_BETA_HOST ?? 'http://issue67-beta.courses.test';
const php = process.env.COURSES_PHP ?? '/Users/hosamalzagh/Library/Application Support/Herd/bin/php85';
const apiDirectory = resolve(__dirname, '../../api');
const port = process.env.COURSES_SHARING_DB_PORT;
let credentials: Record<string, { email: string; password: string; id: number }>;
let credentialDirectory: string;
const suffix = Date.now();
async function login(page: Page, role: string, target = host) {
  await page.goto(`${target}/login`);
  await page.getByRole('button', { name: 'إظهار كلمة المرور', exact: true }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'إخفاء كلمة المرور', exact: true }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'password');
  await page.getByRole('textbox', { name: 'البريد الإلكتروني', exact: true }).fill(credentials[role].email);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(credentials[role].password);
  const response = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'دخول المركز', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(`${target}/admin`);
}
async function write(page: Page, route: string, method: string, payload: unknown) {
  return page.evaluate(async ({ route, method, payload }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find((cookie) => cookie.startsWith('XSRF-TOKEN='))?.slice(11);
    const response = await fetch(`/api/v1/center/${route}`, { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
}
function sql(query: string) {
  return execFileSync('psql', ['-h', '127.0.0.1', '-p', port!, '-U', 'postgres', '-d', 'courses_issue67_browser', '-At', '-c', query], { stdio: 'pipe' }).toString().trim();
}
async function budget(page: Page, navigate: () => Promise<unknown>, cold = false) {
  if (cold) execFileSync(php, ['artisan', 'cache:clear', '--no-interaction'], { cwd: apiDirectory, stdio: 'pipe' });
  const cursor = Number(sql('select coalesce(max(sequence), 0) from telescope_entries'));
  await navigate(); await expect(page.locator('main')).toBeVisible();
  const metrics = () => JSON.parse(sql(`with requests as (select batch_id, content::jsonb as data from telescope_entries where type = 'request' and sequence > ${cursor} and content::jsonb->'headers'->>'host' = '${new URL(host).hostname}' and content::jsonb->>'uri' like '%api/v1/center/%') select json_build_object('requests', (select count(*) from requests), 'counted', (select sum((data->'response_headers'->>'x-courses-query-count')::int) from requests), 'recorded', (select count(*) from telescope_entries where type = 'query' and batch_id in (select batch_id from requests)), 'connections', (select count(*) from telescope_entries where type = 'query' and batch_id in (select batch_id from requests) and content::jsonb->>'connection' in ('central', 'tenant')))`));
  await expect.poll(() => metrics().requests).toBeGreaterThan(0);
  const result = metrics(); expect(result.counted).toBeGreaterThan(0); expect(result.recorded).toBe(result.counted); expect(result.connections).toBe(result.counted); expect(result.counted).toBeLessThanOrEqual(6);
  console.log(`Sharing SQL budget: ${JSON.stringify(result)}`);
}
test.beforeAll(() => {
  test.skip(!port, 'Provide an isolated cluster via COURSES_SHARING_DB_PORT and route fixture hosts to this worktree.');
  credentialDirectory = mkdtempSync(join(tmpdir(), 'courses-sharing67-')); const path = join(credentialDirectory, 'credentials.json');
  execFileSync(php, [resolve(__dirname, 'fixtures/student-sharing.php')], { env: { ...process.env, COURSES_SHARING_CREDENTIALS: path }, stdio: 'pipe' });
  credentials = JSON.parse(readFileSync(path, 'utf8'));
});
test.afterAll(() => { if (credentialDirectory) rmSync(credentialDirectory, { recursive: true }); });
test('owner configures new defaults and audited sharing separately in RTL and narrow dark UI', async ({ page }) => {
  test.setTimeout(120_000); await login(page, 'owner');
  const branch = await write(page, 'branches', 'POST', { name: `Sharing north ${suffix}`, slug: `sharing-north-${suffix}` }); expect(branch.status).toBe(201);
  const policy = await (await page.request.get(`${host}/api/v1/center/student-search-workspace`)).json();
  expect((await write(page, 'student-search-policy', 'PATCH', { default_sharing_enabled: true, enabled: false, revision: policy.policy.revision })).status).toBe(200);
  const first = await write(page, 'students', 'POST', { name: `Earlier sharing ${suffix}`, branch_ids: [branch.body.branch.id], request_id: crypto.randomUUID() }); expect(first.status).toBe(201);
  await budget(page, () => page.goto(`${host}/admin/student-search`), true);
  await page.getByRole('button', { name: 'تغيير افتراضي المشاركة', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('تبقى اختيارات الطلاب الموجودين محفوظة');
  await page.getByRole('dialog').getByRole('button', { name: 'غلق المشاركة للملفات الجديدة', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'حُفظ افتراضي' })).toBeVisible();
  expect((await (await page.request.get(`${host}/api/v1/center/student-search-workspace`)).json()).policy.enabled).toBe(false);
  expect((await (await page.request.get(`${host}/api/v1/center/students/${first.body.student.id}`)).json()).students[0].sharing_enabled).toBe(true);
  await page.goto(`${host}/admin/students`); await page.getByRole('link', { name: 'إنشاء ملف طالب', exact: true }).click();
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`New sharing ${suffix}`);
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click(); await expect(page).toHaveURL(/\/admin\/students\/[a-f0-9-]+\?focus=edit$/);
  const student = (await (await page.request.get(`${host}/api/v1/center/student-workspace?q=${encodeURIComponent(`New sharing ${suffix}`)}`)).json()).students[0]; expect(student.sharing_enabled).toBe(false);
  await budget(page, () => page.goto(`${host}/admin/students/${student.id}`), true);
  await expect(page.getByText('المشاركة بين الفروع: مغلقة', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('button', { name: 'إلغاء', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'السماح بمشاركة الطالب', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('حُفظ اختيار مشاركة الطالب'); await page.reload(); await expect(page.getByText('المشاركة بين الفروع: مسموحة', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click(); await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`Updated sharing ${suffix}`);
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/admin/students/${student.id}\\?focus=edit$`));
  expect((await (await page.request.get(`${host}/api/v1/center/students/${student.id}`)).json()).students[0].sharing_enabled).toBe(true);
  await page.goto(`${host}/admin/audit`); await expect(page.getByText('تغيير مشاركة الطالب', { exact: true }).first()).toBeVisible(); await page.getByText('عرض تغيير مشاركة الطالب', { exact: true }).first().click(); await expect(page.getByText('قبل التغيير: مغلقة', { exact: true }).first()).toBeVisible();
  await page.context().addCookies([{ name: 'courses_theme', value: 'dark', url: host }]); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${host}/admin/students/${student.id}`);
  expect(await page.locator('html').getAttribute('dir')).toBe('rtl'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.screenshot({ path: '/tmp/courses-issue67-mobile-dark.png', fullPage: true }); await page.getByRole('dialog').getByRole('button', { name: 'إلغاء', exact: true }).click();
});
test('staff discovery and similarity respect sharing, revocation, direct access, CSRF and center isolation', async ({ browser }) => {
  test.setTimeout(120_000); const owner = await browser.newPage(); const staff = await browser.newPage(); const beta = await browser.newPage();
  try {
    await login(owner, 'owner');
    const north = await write(owner, 'branches', 'POST', { name: `Staff north ${suffix}`, slug: `staff-north-${suffix}` }); const south = await write(owner, 'branches', 'POST', { name: `Staff south ${suffix}`, slug: `staff-south-${suffix}` });
    const members = await (await owner.request.get(`${host}/api/v1/center/member-workspace`)).json(); const member = members.members.find((row: { user: { id: number } }) => row.user.id === credentials.staff.id);
    expect((await write(owner, `members/${member.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north.body.branch.id]: ['registration', 'center_student_search'] } })).status).toBe(200);
    const policy = await (await owner.request.get(`${host}/api/v1/center/student-search-workspace`)).json(); expect((await write(owner, 'student-search-policy', 'PATCH', { enabled: true, default_sharing_enabled: true, revision: policy.policy.revision })).status).toBe(200);
    const name = `Cross branch ${suffix}`; const hidden = await write(owner, 'students', 'POST', { name, phone: '01234567890', branch_ids: [south.body.branch.id], request_id: crypto.randomUUID() });
    await login(staff, 'staff'); await budget(staff, () => staff.goto(`${host}/admin/student-search?q=${encodeURIComponent(name)}`), true);
    await expect(staff.getByRole('table')).toContainText(name); await expect(staff.getByRole('table').getByRole('link')).toHaveCount(0);
    const result = await (await staff.request.get(`${host}/api/v1/center/student-search-workspace?q=${encodeURIComponent(name)}`)).json(); expect(Object.keys(result.students[0]).sort()).toEqual(['id', 'name', 'phone', 'student_number', 'within_scope']);
    expect((await staff.request.get(`${host}/api/v1/center/students/${hidden.body.student.id}`)).status()).toBe(404); expect((await write(staff, `students/${hidden.body.student.id}/sharing`, 'PATCH', { sharing_enabled: false, revision: 1 })).status).toBe(404);
    await staff.goto(`${host}/admin/students`); await staff.getByRole('link', { name: 'إنشاء ملف طالب', exact: true }).click(); await staff.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(name); await staff.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click(); await expect(staff.getByRole('status').filter({ hasText: 'توجد ملفات ببيانات متشابهة' })).toContainText(name);
    expect((await write(owner, `students/${hidden.body.student.id}/sharing`, 'PATCH', { sharing_enabled: false, revision: 1 })).status).toBe(200);
    await staff.goto(`${host}/admin/student-search?q=${encodeURIComponent(name)}`); await expect(staff.getByRole('table')).not.toContainText(name); expect((await (await staff.request.get(`${host}/api/v1/center/students/similar?name=${encodeURIComponent(name)}`)).json()).students).toHaveLength(0);
    const inside = await write(staff, 'students', 'POST', { name: `Private inside ${suffix}`, branch_ids: [north.body.branch.id], request_id: crypto.randomUUID() }); expect(inside.status).toBe(201); expect((await write(staff, `students/${inside.body.student.id}/sharing`, 'PATCH', { sharing_enabled: false, revision: 1 })).status).toBe(200); expect((await staff.request.get(`${host}/api/v1/center/students/${inside.body.student.id}`)).status()).toBe(200);
    await staff.goto(`${host}/admin/students/${inside.body.student.id}`); await staff.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true }).click();
    expect((await write(owner, `members/${member.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north.body.branch.id]: ['attendance'] } })).status).toBe(200); await staff.getByRole('dialog').getByRole('button', { name: 'السماح بمشاركة الطالب', exact: true }).click(); await expect(staff.locator('.notice-error[role=alert]')).toBeVisible(); await expect(staff.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true })).toHaveCount(0); expect((await staff.request.get(`${host}/api/v1/center/student-search-workspace`)).status()).toBe(403);
    await login(beta, 'owner', betaHost); expect((await beta.request.get(`${betaHost}/api/v1/center/students/${hidden.body.student.id}`)).status()).toBe(404);
    expect((await owner.request.patch(`${host}/api/v1/center/students/${hidden.body.student.id}/sharing`, { data: { sharing_enabled: true, revision: 2 } })).status()).toBe(419);
  } finally { await Promise.all([owner.close(), staff.close(), beta.close()]); }
});

test('simultaneous sharing and profile writes conflict safely and interrupted replies recover without duplicate events', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage(); const other = await browser.newPage();
  try {
    await login(page, 'owner'); await login(other, 'owner');
    const branch = await write(page, 'branches', 'POST', { name: `Concurrent ${suffix}`, slug: `concurrent-${suffix}` }); expect(branch.status).toBe(201);
    const policy = await (await page.request.get(`${host}/api/v1/center/student-search-workspace`)).json();
    expect((await write(page, 'student-search-policy', 'PATCH', { default_sharing_enabled: true, revision: policy.policy.revision })).status).toBe(200);
    const created = await write(page, 'students', 'POST', { name: `Concurrent student ${suffix}`, branch_ids: [branch.body.branch.id], request_id: crypto.randomUUID() }); expect(created.status).toBe(201);
    const id = created.body.student.id; const route = `students/${id}`; const name = `Concurrent updated ${suffix}`;
    const outcomes = await Promise.all([
      write(page, `${route}/sharing`, 'PATCH', { sharing_enabled: false, revision: 1 }),
      write(other, route, 'PATCH', { name, branch_ids: [branch.body.branch.id], revision: 1 }),
    ]);
    expect(outcomes.map((result) => result.status).sort()).toEqual([200, 409]);
    const current = (await (await page.request.get(`${host}/api/v1/center/${route}`)).json()).students[0]; expect(current.revision).toBe(2);
    const retry = outcomes[0].status === 409
      ? await write(page, `${route}/sharing`, 'PATCH', { sharing_enabled: false, revision: current.revision })
      : await write(other, route, 'PATCH', { name, branch_ids: [branch.body.branch.id], revision: current.revision });
    expect(retry.status).toBe(200); expect(retry.body.student.revision).toBe(3);
    const audit = async () => (await (await page.request.get(`${host}/api/v1/center/audit`)).json()).entries
      .filter((entry: { event: string; details: string }) => ['student.sharing_changed', 'student.updated'].includes(entry.event) && JSON.parse(entry.details).student_id === id);
    expect(await audit()).toHaveLength(2);
    const repeated = await Promise.all([write(page, `${route}/sharing`, 'PATCH', { sharing_enabled: false, revision: 1 }), write(other, `${route}/sharing`, 'PATCH', { sharing_enabled: false, revision: 1 })]);
    expect(repeated.map((result) => result.status)).toEqual([200, 200]); expect(await audit()).toHaveLength(2);
    await page.goto(`${host}/admin/students/${id}`);
    await page.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true }).click();
    expect((await write(other, route, 'PATCH', { name: `Newer name ${suffix}`, branch_ids: [branch.body.branch.id], revision: 3 })).status).toBe(200);
    await page.getByRole('dialog').getByRole('button', { name: 'السماح بمشاركة الطالب', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'تغيّر ملف الطالب' })).toBeVisible();
    await page.getByRole('button', { name: 'تحميل أحدث بيانات المشاركة', exact: true }).click();
    await expect(page.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true })).toBeEnabled();
    await page.route(`**/api/v1/center/${route}/sharing`, async (intercept) => { await intercept.fetch(); await intercept.abort('connectionfailed'); }, { times: 1 });
    await page.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'السماح بمشاركة الطالب', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'تعذر التأكد' })).toBeVisible();
    await page.getByRole('button', { name: 'تحميل أحدث بيانات المشاركة', exact: true }).click();
    await expect(page.getByText('المشاركة بين الفروع: مسموحة', { exact: true })).toBeVisible();
    expect(await audit()).toHaveLength(4);
    await page.goto(`${host}/admin/students/${id}`);
    await budget(page, async () => { await page.getByRole('link', { name: 'العودة إلى ملفات الطلاب', exact: true }).click(); await expect(page).toHaveURL(`${host}/admin/students`); }, true);
  } finally { await Promise.all([page.close(), other.close()]); }
});

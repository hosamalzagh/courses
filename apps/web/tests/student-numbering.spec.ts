import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// This suite requires its own Next.js/Laravel/PostgreSQL fixtures.
const host = process.env.COURSES_NUMBERING_ORIGIN ?? '';
const fixturePath = process.env.COURSES_NUMBERING_FIXTURES ?? '';
const php = process.env.COURSES_PHP_BIN ?? (process.platform === 'darwin' ? 'php85' : 'php');
const apiDirectory = path.resolve(process.cwd(), '../api');
test.skip(!host || !fixturePath, 'Requires isolated numbering browser fixtures.');
function credentials(center: 'alpha' | 'beta', role: 'owner' | 'staff') { return JSON.parse(readFileSync(fixturePath, 'utf8'))[center][role]; }
async function login(page: Page, center: 'alpha' | 'beta', role: 'owner' | 'staff') {
  const origin = center === 'alpha' ? host : host.replace('alpha.', 'beta.');
  const user = credentials(center, role);
  await page.goto(`${origin}/login`);
  await page.waitForLoadState("networkidle");
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(user.email);
    await page.getByRole('textbox', { name: 'كلمة المرور' }).fill(user.password);
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'دخول المركز' }).click();
    const response = await responsePromise;
    if (response.status() === 429) { await page.waitForTimeout((Number(response.headers()['retry-after'] ?? 60) + 1) * 1000); continue; }
    expect(response.status()).toBe(200); break;
  }
  await expect(page).toHaveURL(`${origin}/admin`);
}
async function write(page: Page, route: string, method: string, payload: object) {
  return page.evaluate(async ({ route, method, payload }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find((part) => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
}
function phpJson(code: string, environment: Record<string, string> = {}) {
  return JSON.parse(execFileSync(php, ['artisan', 'tinker', '--no-interaction', `--execute=${code}`], { cwd: apiDirectory, env: { ...process.env, ...environment }, stdio: 'pipe' }).toString().trim());
}
async function measure(page: Page, url: string, navigate = false) {
  const cursor = phpJson(String.raw`echo json_encode(\Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0);`);
  if (navigate) { await page.getByRole('link', { name: 'الطلاب', exact: true }).click(); await expect(page).toHaveURL(url); } else { await page.goto(url); }
  await expect(page.getByRole('link', { name: 'الطلاب', exact: true }).first()).toBeVisible();
  const metrics = () => phpJson(String.raw`
    $requests = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TEST_CURSOR'))->whereRaw("split_part(content::jsonb->'headers'->>'host', ':', 1) = ?", [getenv('COURSES_TEST_HOST')])->get(['batch_id','content']);
    $queries = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->where('type', 'query')->whereIn('batch_id', $requests->pluck('batch_id'))->pluck('content')->map(fn ($content) => json_decode($content, true));
    $headers = $requests->map(fn ($row) => json_decode($row->content, true)['response_headers']);
    echo json_encode(['requests'=>$requests->count(), 'total'=>$headers->sum(fn ($header) => (int) ($header['x-courses-query-count'] ?? -1000)), 'recorded'=>$queries->count(), 'connections'=>$queries->countBy('connection')]);
  `, { COURSES_TEST_CURSOR: String(cursor), COURSES_TEST_HOST: new URL(host).hostname });
  await expect.poll(() => metrics().requests).toBeGreaterThan(0);
  const result = metrics();
  expect(result.total).toBeGreaterThan(0); expect(result.recorded).toBe(result.total); expect(result.total).toBeLessThanOrEqual(6);
  return result;
}

test('numbering, printable barcode, keyboard scan, branch/center isolation and page budgets', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await browser.newPage(), staff = await browser.newPage(), beta = await browser.newPage();
  try {
    await login(owner, 'alpha', 'owner');
    const stamp = Date.now(), start = stamp * 100;
    const north = await write(owner, 'branches', 'POST', { name: `شمال ${stamp}`, slug: `north-${stamp}` });
    const south = await write(owner, 'branches', 'POST', { name: `جنوب ${stamp}`, slug: `south-${stamp}` });
    expect(north.status).toBe(201); expect(south.status).toBe(201);
    const setting = (await (await owner.request.get(`${host}/api/v1/center/settings`)).json()).settings;
    await owner.goto(`${host}/admin/settings?tab=students`);
    await owner.getByRole('spinbutton', { name: 'بداية ترقيم الطلاب' }).fill('0');
    await owner.getByRole('button', { name: 'حفظ بداية الترقيم' }).click();
    await expect(owner.getByRole('spinbutton', { name: 'بداية ترقيم الطلاب' })).toHaveAttribute('aria-invalid', 'true');
    await expect(owner.getByRole('spinbutton', { name: 'بداية ترقيم الطلاب' })).toBeFocused();
    await owner.getByRole('spinbutton', { name: 'بداية ترقيم الطلاب' }).fill(String(start));
    await owner.getByRole('button', { name: 'حفظ بداية الترقيم' }).click();
    await expect(owner.getByRole('status')).toContainText('حُفظت بداية ترقيم الطلاب.');
    await owner.goto(`${host}/admin/students`);
    const name = `طالب باركود ${stamp}`;
    await owner.getByRole('link', { name: 'إنشاء ملف طالب' }).click();
    await owner.getByRole('textbox', { name: 'اسم الطالب' }).fill(name);
    await owner.getByRole('checkbox', { name: north.body.branch.name, exact: true }).check();
    let saved: { id: string; student_number: number } | undefined;
    let lost = false;
    await owner.route('**/api/v1/center/students', async (route) => {
      if (route.request().method() !== 'POST' || lost) return route.continue();
      const response = await route.fetch(); saved = (await response.json()).student; lost = true; await route.abort();
    });
    await owner.getByRole('button', { name: 'حفظ ملف الطالب' }).click();
    await expect(owner.getByRole('alert')).toBeVisible();
    await owner.getByRole('button', { name: 'حفظ ملف الطالب' }).click();
    await expect(owner).toHaveURL(/\/admin\/students\/[a-f0-9-]+\?focus=edit$/);
    expect(saved?.student_number).toBe(start);
    await owner.unroute('**/api/v1/center/students');
    const payload = { name: `ثان ${stamp}`, branch_ids: [south.body.branch.id], request_id: crypto.randomUUID() };
    const second = await write(owner, 'students', 'POST', payload);
    expect(second.status).toBe(201); expect(second.body.student.student_number).toBe(start + 1);
    expect((await write(owner, 'student-numbering', 'PATCH', { start: 1, revision: setting.student_number_revision + 1 })).status).toBe(200);
    const third = await write(owner, 'students', 'POST', { ...payload, request_id: crypto.randomUUID() });
    expect(third.body.student.student_number).toBe(start + 2);
    await owner.goto(`${host}/admin/students/${saved!.id}`);
    const popupPromise = owner.waitForEvent('popup');
    await owner.getByRole('link', { name: 'طباعة الباركود الأساسي' }).click();
    const popup = await popupPromise;
    await expect(popup.locator('svg')).toBeVisible(); expect(await popup.locator('svg').getAttribute('aria-label')).toBe(String(start));
    await expect(popup.locator('body')).not.toContainText(name);
    mkdirSync('test-results/numbering', { recursive: true });
    await popup.locator('svg').screenshot({ path: 'test-results/numbering/barcode.png' });
    await popup.evaluate(() => { window.print = () => { document.body.dataset.printed = 'yes'; }; });
    await popup.getByRole('button', { name: 'طباعة الباركود' }).click(); await expect(popup.locator('body')).toHaveAttribute('data-printed', 'yes'); await popup.close();
    expect((await write(owner, `members/${credentials('alpha', 'staff').membership}/grants`, 'PUT', { center_roles: [], branch_roles: { [north.body.branch.id]: ['registration'] } })).status).toBe(200);
    await login(staff, 'alpha', 'staff'); await staff.goto(`${host}/admin/students`);
    await staff.getByRole('textbox', { name: 'البحث في جميع الملفات المصرح بها' }).fill(String(start));
    await staff.getByRole('textbox', { name: 'البحث في جميع الملفات المصرح بها' }).press('Enter');
    await expect(staff.getByRole('heading', { name, exact: true })).toBeVisible();
    await staff.goto(`${host}/admin/students/${saved!.id}`); await expect(staff.getByRole('link', { name: 'طباعة الباركود الأساسي' })).toBeVisible();
    expect((await staff.request.get(`${host}/api/v1/center/students/${second.body.student.id}/barcode`)).status()).toBe(404);
    expect((await write(staff, 'student-numbering', 'PATCH', { start: 100, revision: 1 })).status).toBe(403);
    const metrics = [];
    metrics.push({ route: 'short-student-search', cold: await measure(owner, `${host}/admin/students?q=${encodeURIComponent(name)}`), warm: await measure(owner, `${host}/admin/students?q=${encodeURIComponent(name)}`) });
    for (let index = 0; index < 51; index++) expect((await write(owner, 'students', 'POST', { name: `قياس ${stamp} ${index}`, branch_ids: [north.body.branch.id], request_id: crypto.randomUUID() })).status).toBe(201);
    for (const route of ['/admin/settings?tab=students', '/admin/students', `/admin/students/${saved!.id}`]) metrics.push({ route, cold: await measure(owner, `${host}${route}`), warm: await measure(owner, `${host}${route}`) });
    await owner.goto(`${host}/admin/settings?tab=students`);
    metrics.push({ route: 'client-navigation-to-students', navigation: await measure(owner, `${host}/admin/students`, true) });
    await owner.goto(`${host}/admin/students/${saved!.id}`); await owner.waitForLoadState('networkidle'); await owner.screenshot({ path: 'test-results/numbering/desktop.png', fullPage: true });
    await owner.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
    await expect(owner.locator('html')).toHaveAttribute('data-theme', 'dark'); await owner.screenshot({ path: 'test-results/numbering/dark.png', fullPage: true });
    await owner.setViewportSize({ width: 390, height: 844 }); await owner.screenshot({ path: 'test-results/numbering/mobile.png', fullPage: true });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await write(owner, `members/${credentials('alpha', 'staff').membership}/grants`, 'PUT', { center_roles: [], branch_roles: { [south.body.branch.id]: ['attendance'] } });
    expect((await staff.request.get(`${host}/api/v1/center/students/${saved!.id}/barcode`)).status()).toBe(404);
    await login(beta, 'beta', 'owner');
    expect((await beta.request.get(`${host.replace('alpha.', 'beta.')}/api/v1/center/students/${saved!.id}/barcode`)).status()).toBe(404);
    expect((await (await beta.request.get(`${host.replace('alpha.', 'beta.')}/api/v1/center/settings`)).json()).settings.student_number_start).toBe(1);
    writeFileSync('test-results/numbering/metrics.json', JSON.stringify({ metrics, number: start }, null, 2));
  } finally { await Promise.all([owner.close(), staff.close(), beta.close()]); }
});

test('concurrent branch creation, duplicate requests and numbering revisions', async ({ browser }) => {
  test.setTimeout(120_000);
  const first = await browser.newPage(), second = await browser.newPage();
  try {
    await login(first, 'alpha', 'owner'); await login(second, 'alpha', 'owner');
    const branches = (await (await first.request.get(`${host}/api/v1/center/user`)).json()).branches;
    const setting = (await (await first.request.get(`${host}/api/v1/center/settings`)).json()).settings;
    const start = Date.now() * 100;
    const change = await write(first, 'student-numbering', 'PATCH', { start, revision: setting.student_number_revision }); expect(change.status).toBe(200);
    const payload = { name: `متزامن ${start}`, request_id: crypto.randomUUID(), branch_ids: [branches[0].id] };
    const created = await Promise.all([write(first, 'students', 'POST', payload), write(second, 'students', 'POST', { ...payload, branch_ids: [branches[1].id], request_id: crypto.randomUUID() })]);
    expect(created.map((result) => result.status)).toEqual([201, 201]); expect(created.map((result) => result.body.student.student_number).sort()).toEqual([start, start + 1]);
    const repeat = { ...payload, request_id: crypto.randomUUID() };
    const repeated = await Promise.all([write(first, 'students', 'POST', repeat), write(second, 'students', 'POST', repeat)]);
    expect(repeated.map((result) => result.status).sort()).toEqual([200, 201]); expect(repeated[0].body.student.id).toBe(repeated[1].body.student.id); expect(repeated[0].body.student.student_number).toBe(start + 2);
    const changes = await Promise.all([write(first, 'student-numbering', 'PATCH', { start: start + 100, revision: change.body.settings.student_number_revision }), write(second, 'student-numbering', 'PATCH', { start: start + 200, revision: change.body.settings.student_number_revision })]);
    expect(changes.map((result) => result.status).sort()).toEqual([200, 409]);
    await second.goto(`${host}/admin/settings?tab=students`);
    const current = (await (await first.request.get(`${host}/api/v1/center/settings`)).json()).settings;
    await write(first, 'student-numbering', 'PATCH', { start: start + 300, revision: current.student_number_revision });
    await second.getByRole('spinbutton', { name: 'بداية ترقيم الطلاب' }).fill(String(start + 400)); await second.getByRole('button', { name: 'حفظ بداية الترقيم' }).click();
    await expect(second.getByRole('button', { name: 'تحميل إعداد الترقيم الحالي' })).toBeVisible(); await second.getByRole('button', { name: 'تحميل إعداد الترقيم الحالي' }).click();
    await expect(second.getByRole('spinbutton', { name: 'بداية ترقيم الطلاب' })).toHaveValue(String(start + 300));
  } finally { await first.close(); await second.close(); }
});

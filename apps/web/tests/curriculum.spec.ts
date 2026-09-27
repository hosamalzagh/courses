import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { credentials, ensureLocalFixtures, signIn } from './local-fixtures';
import type { MemberContext } from '@/lib/server-context';
import type { CurriculumContext, Level } from '@/lib/curriculum';
const host = 'http://alpha.courses.test';
const php = process.env.COURSES_PHP_BIN ?? (process.platform === 'darwin' ? 'php85' : 'php');
const apiDirectory = path.resolve(process.cwd(), '../api');
const createdCourseIds = new Set<string>();
async function write(page: Page, route: string, method: string, payload: object) {
  const result = await page.evaluate(async ({ route, method, payload }) => {
    await fetch('/sanctum/csrf-cookie', { cache: 'no-store', credentials: 'same-origin' });
    const token = document.cookie.split('; ').find((part) => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
  if (route === 'courses' && result.status === 201) createdCourseIds.add(result.body.course.id);
  return result;
}
async function sequence(page: Page, branchId: number, name: string): Promise<Level> {
  const course = await write(page, 'courses', 'POST', { branch_id: branchId, name, request_id: crypto.randomUUID() });
  expect(course.status).toBe(201);
  const stage = await write(page, `courses/${course.body.course.id}/stages`, 'POST', { name, request_id: crypto.randomUUID() }); expect(stage.status).toBe(201);
  const level = await write(page, `stages/${stage.body.stage.id}/levels`, 'POST', { name, request_id: crypto.randomUUID(), lectures: [{ number: 1, content: 'محتوى مستقل', title: null, planned_hours: 2 }] }); expect(level.status).toBe(201);
  return level.body.level;
}
function cursor(): number {
  return Number(execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;`], { cwd: apiDirectory, stdio: 'pipe' }).toString().trim());
}
function metricsAfter(sequence: number) {
  return JSON.parse(execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
    $requests = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_CURRICULUM_CURSOR'))
      ->whereRaw("content::jsonb->'headers'->>'host' = ?", ['alpha.courses.test'])->get(['batch_id', 'content']);
    $queries = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->where('type', 'query')->whereIn('batch_id', $requests->pluck('batch_id'))->pluck('content')->map(fn ($row) => json_decode($row, true));
    $counts = $queries->countBy('connection');
    echo json_encode(['requests' => $requests->count(), 'recorded' => $queries->count(), 'central' => $counts['central'] ?? 0, 'tenant' => $counts['tenant'] ?? 0,
      'total' => $requests->sum(fn ($row) => (int) (json_decode($row->content, true)['response_headers']['x-courses-query-count'] ?? -1))]);
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_CURRICULUM_CURSOR: String(sequence) }, stdio: 'pipe' }).toString().trim()) as { requests: number; recorded: number; central: number; tenant: number; total: number };
}
async function budget(page: Page, route: string, cold: boolean) {
  const before = cursor(); if (cold) execFileSync(php, ['artisan', 'cache:clear', '--no-interaction'], { cwd: apiDirectory, stdio: 'pipe' });
  expect((await page.goto(`${host}/${route}`))?.status()).toBe(200); await expect.poll(() => metricsAfter(before).requests).toBeGreaterThan(0);
  const metrics = metricsAfter(before); expect(metrics.total).toBeGreaterThan(0); expect(metrics.recorded).toBe(metrics.total); expect(metrics.central + metrics.tenant).toBe(metrics.total); expect(metrics.total).toBeLessThanOrEqual(6);
}
test.beforeAll(async ({ browser }) => { test.setTimeout(180_000); await ensureLocalFixtures(browser); mkdirSync('/tmp/courses-issue24', { recursive: true }); });
test.afterEach(() => {
  if (!createdCourseIds.size) return;
  execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Local fixture cleanup only');
    $courses = json_decode(getenv('COURSES_CURRICULUM_IDS'), true, flags: JSON_THROW_ON_ERROR);
    foreach ($courses as $id) if (!\Illuminate\Support\Str::isUuid($id)) throw new \RuntimeException('Unexpected fixture id');
    \App\Models\Center::where('slug', 'alpha')->firstOrFail()->run(function () use ($courses) {
      \Illuminate\Support\Facades\DB::transaction(function () use ($courses) {
        $rows = \Illuminate\Support\Facades\DB::table('courses')->whereIn('id', $courses)->get();
        foreach ($rows as $row) if (!preg_match('/^(منهج قبول|منهج محجوب|منهج مصرح|منهج متزامن|منهج استعادة) [0-9]{13}/u', $row->name)) throw new \RuntimeException('Unexpected curriculum fixture');
        $stages = \Illuminate\Support\Facades\DB::table('stages')->whereIn('course_id', $courses)->pluck('id');
        $levels = \Illuminate\Support\Facades\DB::table('levels')->whereIn('stage_id', $stages)->pluck('id');
        $plans = \Illuminate\Support\Facades\DB::table('study_plan_versions')->whereIn('level_id', $levels)->pluck('id');
        $ids = [...$courses, ...$stages, ...$levels];
        \Illuminate\Support\Facades\DB::table('center_audit_logs')->whereIn(\Illuminate\Support\Facades\DB::raw("details->>'record_id'"), $ids)->delete();
        \Illuminate\Support\Facades\DB::table('curriculum_submissions')->whereIn('record_id', $ids)->delete();
        \Illuminate\Support\Facades\DB::table('plan_lectures')->whereIn('plan_version_id', $plans)->delete();
        \Illuminate\Support\Facades\DB::table('study_plan_versions')->whereIn('id', $plans)->delete();
        \Illuminate\Support\Facades\DB::table('levels')->whereIn('id', $levels)->delete();
        \Illuminate\Support\Facades\DB::table('stages')->whereIn('id', $stages)->delete();
        \Illuminate\Support\Facades\DB::table('courses')->whereIn('id', $courses)->delete();
      });
    });
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_CURRICULUM_IDS: JSON.stringify([...createdCourseIds]) }, stdio: 'pipe' }); createdCourseIds.clear();
});

test('academic staff create the hierarchy and whole lecture plan with validation, conflicts and shared Arabic UI', async ({ page }) => {
  test.setTimeout(120_000); const owner = credentials('alpha'); const name = `منهج قبول ${Date.now()}`;
  await signIn(page, host, owner.email, owner.password); await page.getByRole('link', { name: 'المناهج والخطط', exact: true }).click();
  await budget(page, 'admin/curriculum', true); await budget(page, 'admin/curriculum', false);
  await page.getByRole('button', { name: 'إنشاء كورس', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'اسم الكورس' })).toBeFocused(); await expect(page.getByRole('textbox', { name: 'اسم الكورس' })).toBeEnabled(); await expect(page.getByRole('button', { name: 'حفظ المنهج', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'إلغاء', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'إنشاء كورس', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'اسم الكورس' })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'اسم الكورس' }).fill(name); await page.getByRole('link', { name: 'الفروع', exact: true }).click();
  const leave = page.getByRole('alertdialog', { name: 'مغادرة دون حفظ' }); await expect(leave).toBeVisible(); await leave.getByRole('button', { name: 'إلغاء', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'اسم الكورس' })).toHaveValue(name);
  const courseResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/courses') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); const course = (await (await courseResponse).json()).course; createdCourseIds.add(course.id); await expect(page.getByRole('status').filter({ hasText: 'حُفظ المنهج' })).toBeVisible();
  const courseRow = page.getByRole('row').filter({ has: page.getByRole('heading', { name, exact: true }) }); await courseRow.getByRole('button', { name: 'إضافة مرحلة دراسية' }).click();
  await expect(page.getByRole('textbox', { name: 'اسم المرحلة الدراسية' })).toBeEnabled(); await page.getByRole('textbox', { name: 'اسم المرحلة الدراسية' }).fill('المرحلة التمهيدية'); await page.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); await expect(page.getByRole('heading', { name: 'المرحلة التمهيدية', exact: true })).toBeVisible();
  const stageRow = page.getByRole('row').filter({ has: page.getByRole('heading', { name: 'المرحلة التمهيدية', exact: true }) }); await stageRow.getByRole('button', { name: 'إضافة مستوى وخطته' }).click();
  await expect(page.getByRole('textbox', { name: 'اسم المستوى' })).toBeEnabled(); await page.getByRole('textbox', { name: 'اسم المستوى' }).fill('المستوى الأول'); await page.getByRole('textbox', { name: 'محتوى المحاضرة 1', exact: true }).fill('الحروف دون تقسيم فرعي');
  await page.getByRole('textbox', { name: 'الساعات المخططة للمحاضرة 1', exact: true }).fill('0'); await page.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'الساعات المخططة للمحاضرة 1', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'الساعات المخططة للمحاضرة 1', exact: true }).fill('1.5'); await page.getByRole('button', { name: 'إضافة محاضرة كاملة' }).click();
  await page.getByRole('textbox', { name: 'محتوى المحاضرة 2', exact: true }).fill('الكلمات'); await page.getByRole('textbox', { name: 'عنوان المحاضرة 2 (اختياري)', exact: true }).fill('قراءة');
  const levelResponse = page.waitForResponse((response) => /\/api\/v1\/center\/stages\/[^/]+\/levels$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); const level = (await (await levelResponse).json()).level as Level; await expect(page.getByRole('link', { name: 'المستوى الأول', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'المستوى الأول', exact: true }).click();
  await expect(page).toHaveURL(`${host}/admin/curriculum/${level.id}`);
  await page.getByRole('button', { name: 'تعديل الخطة الأولى' }).click();
  await page.getByRole('textbox', { name: 'محتوى المحاضرة 1', exact: true }).fill('تعديل قبل العودة');
  await page.evaluate(() => history.back());
  await expect(page.getByRole('alertdialog', { name: 'مغادرة دون حفظ' })).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page).toHaveURL(`${host}/admin/curriculum/${level.id}`);
  await expect(page.getByRole('textbox', { name: 'محتوى المحاضرة 1', exact: true })).toHaveValue('تعديل قبل العودة');
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('/admin/curriculum\\?tab=levels'));
  await budget(page, `admin/curriculum/${level.id}`, true); await budget(page, `admin/curriculum/${level.id}`, false);
  const lectures = page.getByRole('region', { name: 'جدول المحاضرات المطلوبة — قابل للتمرير أفقيًا' }); await expect(lectures).toContainText('الحروف دون تقسيم فرعي'); await expect(lectures).toContainText('بدون عنوان');
  await page.getByRole('button', { name: 'تعديل الخطة الأولى' }).click(); await expect(page.getByRole('textbox', { name: 'محتوى المحاضرة 1', exact: true })).toBeEnabled(); const newer = await write(page, `levels/${level.id}/first-plan`, 'PATCH', { plan_version_id: level.plan.id, revision: 1, lectures: [{ number: 1, content: 'الخطة الحالية', planned_hours: 2 }] }); expect(newer.status).toBe(200);
  await page.getByRole('textbox', { name: 'محتوى المحاضرة 1', exact: true }).fill('معاينة قديمة'); await page.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت الخطة' })).toBeVisible();
  await page.getByRole('button', { name: 'تحميل البيانات الحالية للمنهج' }).click(); await expect(page.getByRole('textbox', { name: 'محتوى المحاضرة 1', exact: true })).toHaveValue('الخطة الحالية');
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click(); await expect(page.getByRole('button', { name: 'تعديل الخطة الأولى' })).toBeFocused();
  await page.screenshot({ path: '/tmp/courses-issue24/curriculum-desktop.png', fullPage: true }); await page.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click(); await page.screenshot({ path: '/tmp/courses-issue24/curriculum-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'تعديل الخطة الأولى' }).click(); await expect(page.getByRole('textbox', { name: 'محتوى المحاضرة 1', exact: true })).toBeEnabled(); await page.screenshot({ path: '/tmp/courses-issue24/curriculum-mobile.png', fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click(); await page.goto(`${host}/admin/audit`); await page.getByText('عرض تغيير المنهج', { exact: true }).first().click(); await expect(page.getByText('الخطة الحالية', { exact: false }).first()).toBeVisible();
});

test('branch and center isolation survive direct links and revoked forms while concurrent requests cannot duplicate plans', async ({ browser }) => {
  test.setTimeout(120_000); const owner = await browser.newPage(); const staff = await browser.newPage(); const beta = await browser.newPage(); let original: MemberContext['members'][number] | undefined;
  try {
    const ownerCredentials = credentials('alpha'); const staffCredentials = credentials('staff'); const betaCredentials = credentials('beta'); await signIn(owner, host, ownerCredentials.email, ownerCredentials.password);
    const workspace = await (await owner.request.get(`${host}/api/v1/center/member-workspace`)).json() as MemberContext; original = workspace.members.find((member) => member.user.email === staffCredentials.email)!;
    const north = workspace.branches.find((branch) => branch.slug === 'north')!; const south = workspace.branches.find((branch) => branch.slug === 'south')!; const stamp = Date.now();
    const hidden = await sequence(owner, south.id, `منهج محجوب ${stamp}`); const visible = await sequence(owner, north.id, `منهج مصرح ${stamp}`);
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north.id]: ['academic_admin', 'branch_auditor'] } })).status).toBe(200); await signIn(staff, host, staffCredentials.email, staffCredentials.password);
    const scoped = await (await staff.request.get(`${host}/api/v1/center/curriculum-workspace`)).json() as CurriculumContext; expect(scoped.levels.some((level) => level.id === visible.id)).toBe(true); expect(scoped.levels.some((level) => level.id === hidden.id)).toBe(false); expect(JSON.stringify(scoped)).not.toContain(hidden.name);
    expect((await staff.request.get(`${host}/api/v1/center/levels/${hidden.id}`)).status()).toBe(404); await staff.goto(`${host}/admin/curriculum/${hidden.id}`); await expect(staff.getByRole('heading', { name: 'خطة المستوى غير متاحة' })).toBeVisible();
    await staff.goto(`${host}/admin/curriculum/${visible.id}`); await staff.getByRole('button', { name: 'تعديل الخطة الأولى' }).click(); await staff.getByRole('textbox', { name: 'محتوى المحاضرة 1', exact: true }).fill('تعديل ممنوع');
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: {} })).status).toBe(200); await staff.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); await expect(staff.getByRole('alert').filter({ hasText: 'لم يعد متاحًا ضمن صلاحيتك' })).toBeVisible();
    await signIn(beta, 'http://beta.courses.test', betaCredentials.email, betaCredentials.password); expect((await beta.request.get(`http://beta.courses.test/api/v1/center/levels/${visible.id}`)).status()).toBe(404);
    const payload = { name: `منهج متزامن ${stamp}`, branch_id: north.id, request_id: crypto.randomUUID() }; const creations = await Promise.all([write(owner, 'courses', 'POST', payload), write(owner, 'courses', 'POST', payload)]);
    expect(creations.map((result) => result.status).sort()).toEqual([200, 201]); expect(creations[0].body.course.id).toBe(creations[1].body.course.id);
    const edits = await Promise.all([write(owner, `levels/${visible.id}/first-plan`, 'PATCH', { plan_version_id: visible.plan.id, revision: 1, lectures: [{ number: 1, content: 'تعديل أول', planned_hours: 2 }] }), write(owner, `levels/${visible.id}/first-plan`, 'PATCH', { plan_version_id: visible.plan.id, revision: 1, lectures: [{ number: 1, content: 'تعديل ثان', planned_hours: 2 }] })]); expect(edits.map((result) => result.status).sort()).toEqual([200, 409]);
  } finally { if (original) expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: original.center_roles, branch_roles: original.branch_roles })).status).toBe(200); await owner.close(); await staff.close(); await beta.close(); }
});

test('a lost committed creation response recovers the saved curriculum before a changed retry', async ({ page }) => {
  test.setTimeout(90_000); const owner = credentials('alpha'); const name = `منهج استعادة ${Date.now()}`;
  await signIn(page, host, owner.email, owner.password); await page.goto(`${host}/admin/curriculum`); await page.getByRole('button', { name: 'إنشاء كورس', exact: true }).click(); await page.getByRole('textbox', { name: 'اسم الكورس' }).fill(name);
  let id = ''; await page.route('**/api/v1/center/courses', async (route) => { const response = await route.fetch(); expect(response.status()).toBe(201); id = (await response.json()).course.id; createdCourseIds.add(id); await route.abort('connectionclosed'); }, { times: 1 });
  await page.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'تعذر تأكيد الحفظ' })).toBeVisible(); expect(id).toBeTruthy();
  await page.getByRole('textbox', { name: 'اسم الكورس' }).fill(`${name} تعديل`); await page.getByRole('button', { name: 'حفظ المنهج', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت الخطة أو حُفظ الطلب' })).toBeVisible(); await page.getByRole('button', { name: 'تحميل البيانات الحالية للمنهج' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'السجل حُفظ سابقًا' })).toBeVisible(); const workspace = await (await page.request.get(`${host}/api/v1/center/curriculum-workspace`)).json() as CurriculumContext; expect(workspace.courses.filter((course) => course.name.startsWith(name))).toHaveLength(1); expect(workspace.courses.find((course) => course.id === id)?.name).toBe(name);
});

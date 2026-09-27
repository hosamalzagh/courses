import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { credentials, ensureLocalFixtures, signIn } from './local-fixtures';
import type { MemberContext, InstructorContext } from '@/lib/server-context';

const host = 'http://alpha.courses.test';
const php = process.env.COURSES_PHP_BIN ?? (process.platform === 'darwin' ? 'php85' : 'php');
const apiDirectory = path.resolve(process.cwd(), '../api');
const createdInstructorIds = new Set<string>();

async function write(page: Page, route: string, method: string, payload: object) {
  const result = await page.evaluate(async ({ route, method, payload }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find((part) => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
  if (route === 'instructors' && result.status === 201) createdInstructorIds.add(result.body.instructor.id);
  return result;
}

type Metrics = { requests: number; central: number; tenant: number; total: number; recorded: number; duplicates: number; sql_ms: number };

function telescopeCursor(): number {
  return Number(execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') {
      throw new \RuntimeException('Browser query measurements require local courses_central');
    }
    echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;
  `], { cwd: apiDirectory, stdio: "pipe" }).toString().trim());
}

function metricsAfter(cursor: number, host: string): Metrics {
  const result = execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    $requests = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TEST_CURSOR'))
      ->whereRaw("content::jsonb->'headers'->>'host' = ?", [getenv('COURSES_TEST_HOST')])
      ->get(['batch_id', 'content']);
    $queries = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'query')->whereIn('batch_id', $requests->pluck('batch_id'))->pluck('content')
      ->map(fn ($content) => json_decode($content, true));
    $counts = $queries->countBy('connection');
    $patterns = $queries->countBy(fn ($query) => $query['connection'].':'.$query['hash']);
    $headers = $requests->map(fn ($row) => json_decode($row->content, true)['response_headers']);
    echo json_encode([
      'requests' => $requests->count(), 'central' => $counts['central'] ?? 0, 'tenant' => $counts['tenant'] ?? 0,
      'total' => $headers->sum(fn ($header) => (int) ($header['x-courses-query-count'] ?? -1)),
      'recorded' => $queries->count(), 'duplicates' => $patterns->filter(fn ($count) => $count > 1)->count(),
      'sql_ms' => round($headers->sum(fn ($header) => (float) ($header['x-courses-sql-ms'] ?? 0)), 2),
    ]);
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_CURSOR: String(cursor), COURSES_TEST_HOST: host }, stdio: "pipe" }).toString().trim();
  return JSON.parse(result) as Metrics;
}

async function verifyPageBudget(page: Page, url: string, cold: boolean): Promise<Metrics> {
  const cursor = telescopeCursor();
  if (cold) execFileSync(php, ["artisan", "cache:clear", "--no-interaction"], { cwd: apiDirectory, stdio: "pipe" });
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  const host = new URL(url).hostname;
  await expect.poll(() => metricsAfter(cursor, host).requests, { timeout: 10_000 }).toBeGreaterThan(0);
  const metrics = metricsAfter(cursor, host);
  expect(metrics.total).toBeGreaterThan(0);
  expect(metrics.recorded).toBe(metrics.total);
  expect(metrics.central + metrics.tenant).toBe(metrics.total);
  expect(metrics.total).toBeLessThanOrEqual(6);
  return metrics;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await ensureLocalFixtures(browser);
});

test.afterEach(() => {
  if (!createdInstructorIds.size) return;
  execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Local fixture cleanup only');
    $ids = json_decode(getenv('COURSES_TEST_INSTRUCTOR_IDS'), true, flags: JSON_THROW_ON_ERROR);
    foreach ($ids as $id) if (!\Illuminate\Support\Str::isUuid($id)) throw new \RuntimeException('Unexpected fixture identifier');
    \App\Models\Center::where('slug', 'alpha')->firstOrFail()->run(function () use ($ids) {
      \Illuminate\Support\Facades\DB::transaction(function () use ($ids) {
        $rows = \Illuminate\Support\Facades\DB::table('instructors')->whereIn('id', $ids)->get();
        foreach ($rows as $row) if (!preg_match('/^(محاضر قبول|محاضر آخر|محجوب|مصرح|إعادة|متزامن أول|متزامن ثان|استعادة) [0-9]{13}/u', $row->name)) throw new \RuntimeException('Unexpected instructor fixture');
        \Illuminate\Support\Facades\DB::table('center_audit_logs')->whereIn(\Illuminate\Support\Facades\DB::raw("details->>'instructor_id'"), $ids)->delete();
        \Illuminate\Support\Facades\DB::table('instructor_branches')->whereIn('instructor_id', $ids)->delete();
        \Illuminate\Support\Facades\DB::table('instructors')->whereIn('id', $ids)->delete();
      });
    });
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_INSTRUCTOR_IDS: JSON.stringify([...createdInstructorIds]) }, stdio: 'pipe' });
  createdInstructorIds.clear();
});

test('instructor profiles are created without accounts, reused across branches and edited in the shared workspace', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = credentials('alpha');
  const stamp = Date.now();
  const firstName = `محاضر قبول ${stamp}`;
  const secondName = `محاضر آخر ${stamp}`;
  const phone = `010${String(stamp).slice(-8)}`;
  await signIn(page, host, owner.email, owner.password);
  await page.getByRole('link', { name: 'المحاضرون', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ملفات المحاضرين', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1920, height: 1080 });
  expect(await page.locator('.center-content').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1280);
  await page.setViewportSize({ width: 1280, height: 720 });
  await verifyPageBudget(page, `${host}/admin/instructors`, true);
  await verifyPageBudget(page, `${host}/admin/instructors`, false);
  await page.getByRole('button', { name: 'إنشاء ملف محاضر', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'اسم المحاضر', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'حفظ ملف المحاضر', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'اسم المحاضر', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'اسم المحاضر', exact: true }).fill(firstName);
  await page.getByRole('textbox', { name: 'رقم التواصل', exact: true }).fill(phone);
  await page.getByRole('link', { name: 'الفروع', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'اسم المحاضر', exact: true })).toHaveValue(firstName);
  const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/instructors') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ ملف المحاضر', exact: true }).click();
  const first = (await (await createdResponse).json()).instructor;
  createdInstructorIds.add(first.id);
  await expect(page.getByRole('status').filter({ hasText: 'أُنشئ ملف المحاضر' })).toBeVisible();
  await page.getByRole('textbox', { name: 'البحث في جميع الملفات المصرح بها' }).fill(firstName);
  await page.getByRole('button', { name: 'بحث عن محاضر', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: firstName })).toBeVisible();

  await page.getByRole('button', { name: 'إنشاء ملف محاضر', exact: true }).click();
  await page.getByRole('textbox', { name: 'اسم المحاضر', exact: true }).fill(secondName);
  await page.getByRole('textbox', { name: 'رقم التواصل', exact: true }).fill(phone);
  const secondResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/instructors') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ ملف المحاضر', exact: true }).click();
  const second = (await (await secondResponse).json()).instructor;
  createdInstructorIds.add(second.id);
  expect(second.id).not.toBe(first.id);
  await expect(page.getByRole('status').filter({ hasText: 'أُنشئ ملف المحاضر' })).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: firstName });
  await row.getByRole('button', { name: 'تعديل ملف المحاضر' }).click();
  const form = page.getByRole('form', { name: `تعديل ملف ${firstName}` });
  await form.getByRole('textbox', { name: 'اسم المحاضر', exact: true }).fill(`${firstName} معدل`);
  await form.getByRole('checkbox', { name: 'الفرع الجنوبي', exact: true }).check();
  await form.getByRole('button', { name: 'حفظ بيانات المحاضر', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'حُفظت بيانات المحاضر' })).toBeVisible();
  await expect(row).toContainText('الفرع الجنوبي');
  await expect(row).toContainText('الفرع الشمالي');
  await verifyPageBudget(page, `${host}/admin/instructors/${first.id}`, true);
  await verifyPageBudget(page, `${host}/admin/instructors/${first.id}`, false);
  await page.getByRole('button', { name: 'تعديل ملف المحاضر', exact: true }).click();
  const edit = page.getByRole('form', { name: `تعديل ملف ${firstName} معدل` });
  const newer = await write(page, `instructors/${first.id}`, 'PATCH', { name: `${firstName} جديد`, phone, branch_ids: [], revision: 2 });
  expect(newer.status).toBe(200);
  await edit.getByRole('textbox', { name: 'اسم المحاضر', exact: true }).fill(`${firstName} قديم`);
  await edit.getByRole('button', { name: 'حفظ بيانات المحاضر', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت بيانات الملف' })).toBeVisible();
  await edit.getByRole('button', { name: 'تحميل أحدث بيانات المحاضر' }).click();
  await expect(page.getByRole('textbox', { name: 'اسم المحاضر', exact: true })).toHaveValue(`${firstName} جديد`);
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('button', { name: 'تعديل ملف المحاضر', exact: true })).toBeFocused();
  await page.screenshot({ path: '/tmp/courses-issue23/instructors-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
  await page.getByRole('button', { name: 'تعديل ملف المحاضر', exact: true }).click();
  await page.screenshot({ path: '/tmp/courses-issue23/instructors-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: 'اسم المحاضر', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/courses-issue23/instructors-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await page.goto(`${host}/admin/audit`);
  await page.getByText('عرض تغيير ملف المحاضر', { exact: true }).first().click();
  await expect(page.getByText('بعد التغيير:', { exact: false }).first()).toContainText(firstName);
});

test('academic administration scope hides another branch and center and an open form loses revoked authority', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  const beta = await browser.newPage();
  const ownerCredentials = credentials('alpha');
  const staffCredentials = credentials('staff');
  const betaCredentials = credentials('beta');
  let original: MemberContext['members'][number] | undefined;
  try {
    await signIn(owner, host, ownerCredentials.email, ownerCredentials.password);
    const workspace = await (await owner.request.get(`${host}/api/v1/center/member-workspace`)).json() as MemberContext;
    original = workspace.members.find((member) => member.user.email === staffCredentials.email)!;
    const north = workspace.branches.find((branch) => branch.slug === 'north')!;
    const south = workspace.branches.find((branch) => branch.slug === 'south')!;
    const stamp = Date.now();
    const phone = `011${String(stamp).slice(-8)}`;
    const hidden = await write(owner, 'instructors', 'POST', { name: `محجوب ${stamp}`, phone, branch_ids: [south.id], request_id: crypto.randomUUID() });
    expect(hidden.status).toBe(201);
    const visible = await write(owner, 'instructors', 'POST', { name: `مصرح ${stamp}`, branch_ids: [north.id], request_id: crypto.randomUUID() });
    expect(visible.status).toBe(201);
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north.id]: ['academic_admin', 'branch_auditor'] } })).status).toBe(200);
    await signIn(staff, host, staffCredentials.email, staffCredentials.password);
    await staff.getByRole('link', { name: 'المحاضرون', exact: true }).click();
    expect((await staff.request.get(`${host}/api/v1/center/instructors/${hidden.body.instructor.id}`)).status()).toBe(404);
    const scoped = await (await staff.request.get(`${host}/api/v1/center/instructor-workspace`)).json() as InstructorContext;
    expect(scoped.instructors.every((instructor) => !instructor.branch_ids.includes(south.id))).toBe(true);
    await staff.goto(`${host}/admin/instructors/${hidden.body.instructor.id}`);
    await expect(staff.getByRole('heading', { name: 'ملف المحاضر غير متاح' })).toBeVisible();
    await staff.goto(`${host}/admin/instructors/${visible.body.instructor.id}`);
    await staff.getByRole('button', { name: 'تعديل ملف المحاضر' }).click();
    await staff.getByRole('textbox', { name: 'اسم المحاضر', exact: true }).fill(`تعديل ممنوع ${stamp}`);
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: {} })).status).toBe(200);
    await staff.getByRole('button', { name: 'حفظ بيانات المحاضر', exact: true }).click();
    await expect(staff.getByRole('alert').filter({ hasText: 'لم يعد متاحًا ضمن صلاحيتك' })).toBeVisible();
    await signIn(beta, 'http://beta.courses.test', betaCredentials.email, betaCredentials.password);
    expect((await beta.request.get(`http://beta.courses.test/api/v1/center/instructors/${visible.body.instructor.id}`)).status()).toBe(404);
    const requestId = crypto.randomUUID();
    const payload = { name: `إعادة ${stamp}`, branch_ids: [north.id], request_id: requestId };
    const creations = await Promise.all([write(owner, 'instructors', 'POST', payload), write(owner, 'instructors', 'POST', payload)]);
    expect(creations.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(creations[0].body.instructor.id).toBe(creations[1].body.instructor.id);
    const instructor = creations[0].body.instructor;
    const edits = await Promise.all([
      write(owner, `instructors/${instructor.id}`, 'PATCH', { name: `متزامن أول ${stamp}`, branch_ids: [], revision: instructor.revision }),
      write(owner, `instructors/${instructor.id}`, 'PATCH', { name: `متزامن ثان ${stamp}`, branch_ids: [], revision: instructor.revision }),
    ]);
    expect(edits.map((result) => result.status).sort()).toEqual([200, 409]);
  } finally {
    if (original) expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: original.center_roles, branch_roles: original.branch_roles })).status).toBe(200);
    await owner.close(); await staff.close(); await beta.close();
  }
});

test('a committed creation whose response is lost is recovered before editing without creating another instructor', async ({ page }) => {
  test.setTimeout(90_000);
  const owner = credentials('alpha');
  const name = `استعادة ${Date.now()}`;
  await signIn(page, host, owner.email, owner.password);
  await page.goto(`${host}/admin/instructors`);
  await page.getByRole('button', { name: 'إنشاء ملف محاضر', exact: true }).click();
  await page.getByRole('textbox', { name: 'اسم المحاضر', exact: true }).fill(name);
  let savedId = '';
  await page.route('**/api/v1/center/instructors', async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    savedId = (await response.json()).instructor.id;
    createdInstructorIds.add(savedId);
    await route.abort('connectionclosed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'حفظ ملف المحاضر', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'تعذر حفظ الملف' })).toBeVisible();
  expect(savedId).toBeTruthy();
  await page.getByRole('textbox', { name: 'اسم المحاضر', exact: true }).fill(`${name} تعديل`);
  await page.getByRole('button', { name: 'حفظ ملف المحاضر', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت بيانات الملف أو الطلب' })).toBeVisible();
  await page.getByRole('button', { name: 'تحميل أحدث بيانات المحاضر' }).click();
  await expect(page.getByRole('textbox', { name: 'اسم المحاضر', exact: true })).toHaveValue(name);
  await page.getByRole('textbox', { name: 'اسم المحاضر', exact: true }).fill(`${name} تعديل`);
  await page.getByRole('button', { name: 'حفظ بيانات المحاضر', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'حُفظت بيانات المحاضر' })).toBeVisible();
  const records = await (await page.request.get(`${host}/api/v1/center/instructor-workspace?q=${encodeURIComponent(name)}`)).json() as InstructorContext;
  expect(records.instructors).toHaveLength(1);
  expect(records.instructors[0].id).toBe(savedId);
  expect(records.instructors[0].name).toBe(`${name} تعديل`);
});

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { credentials, ensureLocalFixtures, signIn } from './local-fixtures';
import type { MemberContext, StudentContext } from '@/lib/server-context';

const host = 'http://alpha.courses.test';
const php = process.env.COURSES_PHP_BIN ?? (process.platform === 'darwin' ? 'php85' : 'php');
const apiDirectory = path.resolve(process.cwd(), '../api');
const createdStudentIds = new Set<string>();

async function write(page: Page, route: string, method: string, payload: object) {
  const result = await page.evaluate(async ({ route, method, payload }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find((part) => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
  if (route === 'students' && result.status === 201) createdStudentIds.add(result.body.student.id);
  return result;
}

function telescopeCursor() {
  return Number(execFileSync(php, ['artisan', 'tinker', '--no-interaction', String.raw`--execute=echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;`], { cwd: apiDirectory, stdio: 'pipe' }).toString().trim());
}

async function verifyPageBudget(page: Page, url: string) {
  const cursor = telescopeCursor();
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'ملفات الطلاب', exact: true })).toBeVisible();
  await expect.poll(() => {
    const counts = JSON.parse(execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
      echo json_encode(\Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
        ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TEST_CURSOR'))
        ->whereRaw("content::jsonb->'headers'->>'host' = ?", ['alpha.courses.test'])
        ->pluck('content')->map(fn ($row) => (int) (json_decode($row, true)['response_headers']['x-courses-query-count'] ?? 0))->all());
    `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_CURSOR: String(cursor) }, stdio: 'pipe' }).toString().trim()) as number[];
    return counts.length > 0 && counts.every((count) => count > 0) && counts.reduce((sum, count) => sum + count, 0) <= 6;
  }).toBe(true);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await ensureLocalFixtures(browser);
});

test.afterEach(() => {
  if (!createdStudentIds.size) return;
  execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Local fixture cleanup only');
    $ids = json_decode(getenv('COURSES_TEST_STUDENT_IDS'), true, flags: JSON_THROW_ON_ERROR);
    foreach ($ids as $id) if (!\Illuminate\Support\Str::isUuid($id)) throw new \RuntimeException('Unexpected fixture identifier');
    \App\Models\Center::where('slug', 'alpha')->firstOrFail()->run(function () use ($ids) {
      \Illuminate\Support\Facades\DB::transaction(function () use ($ids) {
        $rows = \Illuminate\Support\Facades\DB::table('students')->whereIn('id', $ids)->get();
        foreach ($rows as $row) if (!preg_match('/^(طالب قبول|طالب آخر|محجوب|مصرح|إعادة|متزامن أول|متزامن ثان|استعادة) [0-9]{13}/u', $row->name)) throw new \RuntimeException('Unexpected student fixture');
        \Illuminate\Support\Facades\DB::table('center_audit_logs')->whereIn(\Illuminate\Support\Facades\DB::raw("details->>'student_id'"), $ids)->delete();
        \Illuminate\Support\Facades\DB::table('student_branches')->whereIn('student_id', $ids)->delete();
        \Illuminate\Support\Facades\DB::table('students')->whereIn('id', $ids)->delete();
      });
    });
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_STUDENT_IDS: JSON.stringify([...createdStudentIds]) }, stdio: 'pipe' });
  createdStudentIds.clear();
});

test('student profiles are created, reviewed for similarity, reused and edited in the shared workspace', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = credentials('alpha');
  const stamp = Date.now();
  const firstName = `طالب قبول ${stamp}`;
  const secondName = `طالب آخر ${stamp}`;
  const phone = `010${String(stamp).slice(-8)}`;
  await signIn(page, host, owner.email, owner.password);
  await page.getByRole('link', { name: 'الطلاب', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ملفات الطلاب', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1920, height: 1080 });
  expect(await page.locator('.center-content').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1280);
  await page.setViewportSize({ width: 1280, height: 720 });
  await verifyPageBudget(page, `${host}/admin/students`);
  await verifyPageBudget(page, `${host}/admin/students`);
  await page.getByRole('button', { name: 'إنشاء ملف طالب', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(firstName);
  await page.getByRole('textbox', { name: 'رقم التواصل', exact: true }).fill(phone);
  const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/students') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  const first = (await (await createdResponse).json()).student;
  createdStudentIds.add(first.id);
  await expect(page.getByRole('status').filter({ hasText: 'أُنشئ ملف الطالب' })).toBeVisible();
  await page.getByRole('textbox', { name: 'البحث في جميع الملفات المصرح بها' }).fill(firstName);
  await page.getByRole('button', { name: 'بحث عن طالب', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: firstName })).toBeVisible();

  await page.getByRole('button', { name: 'إنشاء ملف طالب', exact: true }).click();
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(secondName);
  await page.getByRole('textbox', { name: 'رقم التواصل', exact: true }).fill(phone);
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'توجد ملفات ببيانات متشابهة' })).toContainText(firstName);
  const secondResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/students') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'إنشاء ملف مستقل', exact: true }).click();
  const second = (await (await secondResponse).json()).student;
  createdStudentIds.add(second.id);
  expect(second.student_number).not.toBe(first.student_number);
  await expect(page.getByRole('status').filter({ hasText: 'أُنشئ ملف الطالب' })).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: firstName });
  await row.getByRole('button', { name: 'تعديل ملف الطالب' }).click();
  const form = page.getByRole('form', { name: `تعديل ملف ${firstName}` });
  await form.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`${firstName} معدل`);
  await form.getByRole('checkbox', { name: 'الفرع الجنوبي', exact: true }).check();
  await form.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expect(page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'حُفظت بيانات الطالب' })).toBeVisible();
  await expect(row).toContainText('الفرع الجنوبي');
  await expect(row).toContainText('الفرع الشمالي');
  await verifyPageBudget(page, `${host}/admin/students/${first.id}`);
  await page.getByRole('button', { name: 'تعديل ملف الطالب', exact: true }).click();
  const edit = page.getByRole('form', { name: `تعديل ملف ${firstName} معدل` });
  const newer = await write(page, `students/${first.id}`, 'PATCH', { name: `${firstName} جديد`, phone, branch_ids: [], revision: 2 });
  expect(newer.status).toBe(200);
  await edit.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`${firstName} قديم`);
  await edit.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  // The shared contact warning is informational and permits a separate person.
  const saveButton = edit.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true });
  await expect(page.getByRole('status').filter({ hasText: 'توجد ملفات ببيانات متشابهة' })).toBeVisible();
  await saveButton.click();
  await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت بيانات الملف' })).toBeVisible();
  await edit.getByRole('button', { name: 'تحميل أحدث بيانات الطالب' }).click();
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toHaveValue(`${firstName} جديد`);
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('button', { name: 'تعديل ملف الطالب', exact: true })).toBeFocused();
  await page.screenshot({ path: '/tmp/courses-issue21/students-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
  await page.getByRole('button', { name: 'تعديل ملف الطالب', exact: true }).click();
  await page.screenshot({ path: '/tmp/courses-issue21/students-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/courses-issue21/students-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await page.goto(`${host}/admin/audit`);
  await page.getByText('عرض تغيير ملف الطالب', { exact: true }).first().click();
  await expect(page.getByText('بعد التغيير:', { exact: false }).first()).toContainText(firstName);
});

test('registration scope hides another branch and center and an open form loses revoked authority', async ({ browser }) => {
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
    const hidden = await write(owner, 'students', 'POST', { name: `محجوب ${stamp}`, phone, branch_ids: [south.id], request_id: crypto.randomUUID() });
    expect(hidden.status).toBe(201);
    const visible = await write(owner, 'students', 'POST', { name: `مصرح ${stamp}`, branch_ids: [north.id], request_id: crypto.randomUUID() });
    expect(visible.status).toBe(201);
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north.id]: ['registration', 'branch_auditor'] } })).status).toBe(200);
    await signIn(staff, host, staffCredentials.email, staffCredentials.password);
    await staff.getByRole('link', { name: 'الطلاب', exact: true }).click();
    expect((await staff.request.get(`${host}/api/v1/center/students/${hidden.body.student.id}`)).status()).toBe(404);
    const matches = await (await staff.request.get(`${host}/api/v1/center/students/similar?phone=${phone}`)).json();
    expect(matches.students).toEqual([]);
    const scoped = await (await staff.request.get(`${host}/api/v1/center/student-workspace`)).json() as StudentContext;
    expect(scoped.students.every((student) => !student.branch_ids.includes(south.id))).toBe(true);
    await staff.goto(`${host}/admin/students/${hidden.body.student.id}`);
    await expect(staff.getByRole('heading', { name: 'ملف الطالب غير متاح' })).toBeVisible();
    await staff.goto(`${host}/admin/students/${visible.body.student.id}`);
    await staff.getByRole('button', { name: 'تعديل ملف الطالب' }).click();
    await staff.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`تعديل ممنوع ${stamp}`);
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: {} })).status).toBe(200);
    await staff.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
    await expect(staff.getByRole('alert').filter({ hasText: 'لم يعد متاحًا ضمن صلاحيتك' })).toBeVisible();
    await signIn(beta, 'http://beta.courses.test', betaCredentials.email, betaCredentials.password);
    expect((await beta.request.get(`http://beta.courses.test/api/v1/center/students/${visible.body.student.id}`)).status()).toBe(404);
    const otherCenter = await beta.request.get(`http://beta.courses.test/api/v1/center/students/similar?phone=${phone}`);
    expect(otherCenter.status()).toBe(200);
    expect((await otherCenter.json()).students).toEqual([]);

    const requestId = crypto.randomUUID();
    const payload = { name: `إعادة ${stamp}`, branch_ids: [north.id], request_id: requestId };
    const creations = await Promise.all([write(owner, 'students', 'POST', payload), write(owner, 'students', 'POST', payload)]);
    expect(creations.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(creations[0].body.student.id).toBe(creations[1].body.student.id);
    const student = creations[0].body.student;
    const edits = await Promise.all([
      write(owner, `students/${student.id}`, 'PATCH', { name: `متزامن أول ${stamp}`, branch_ids: [], revision: student.revision }),
      write(owner, `students/${student.id}`, 'PATCH', { name: `متزامن ثان ${stamp}`, branch_ids: [], revision: student.revision }),
    ]);
    expect(edits.map((result) => result.status).sort()).toEqual([200, 409]);
  } finally {
    if (original) expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: original.center_roles, branch_roles: original.branch_roles })).status).toBe(200);
    await owner.close(); await staff.close(); await beta.close();
  }
});

test('a committed creation whose response is lost is recovered before editing without creating another student', async ({ page }) => {
  test.setTimeout(90_000);
  const owner = credentials('alpha');
  const name = `استعادة ${Date.now()}`;
  await signIn(page, host, owner.email, owner.password);
  await page.goto(`${host}/admin/students`);
  await page.getByRole('button', { name: 'إنشاء ملف طالب', exact: true }).click();
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(name);
  let savedId = '';
  await page.route('**/api/v1/center/students', async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    savedId = (await response.json()).student.id;
    createdStudentIds.add(savedId);
    await route.abort('connectionclosed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'تعذر حفظ الملف' })).toBeVisible();
  expect(savedId).toBeTruthy();
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`${name} تعديل`);
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت بيانات الملف أو الطلب' })).toBeVisible();
  await page.getByRole('button', { name: 'تحميل أحدث بيانات الطالب' }).click();
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toHaveValue(name);
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`${name} تعديل`);
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'حُفظت بيانات الطالب' })).toBeVisible();
  const records = await (await page.request.get(`${host}/api/v1/center/student-workspace?q=${encodeURIComponent(name)}`)).json() as StudentContext;
  expect(records.students).toHaveLength(1);
  expect(records.students[0].id).toBe(savedId);
  expect(records.students[0].name).toBe(`${name} تعديل`);
});

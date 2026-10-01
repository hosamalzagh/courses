import { expectWorkspaceHref, workspaceUrl } from "./workspace-testhelpers";
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { credentials, ensureLocalFixtures, signIn } from './local-fixtures';
import type { MemberContext, StudentCustomFieldContext, StudentSearchContext, StudentSearchPolicy } from '@/lib/server-context';

const host = process.env.COURSES_SEARCH_HOST ?? 'http://alpha.courses.test';
const php = process.env.COURSES_PHP_BIN ?? (process.platform === 'darwin' ? 'php85' : 'php');
const apiDirectory = path.resolve(process.cwd(), '../api');
const studentIds = new Set<string>();

async function requiredCustomFields(page: Page) {
  const required: StudentCustomFieldContext['fields'] = [];
  let current: StudentCustomFieldContext;
  let batch = 1;
  do {
    const response = await page.request.get(`${host}/api/v1/center/student-custom-fields?page=${batch++}`);
    expect(response.status()).toBe(200);
    current = await response.json() as StudentCustomFieldContext;
    required.push(...current.fields.filter(field => field.active && field.required));
  } while (current.pagination.has_more);
  return { fields: required, revision: current.revision, values: Object.fromEntries(required.map(field => [field.id,
    field.type === 'number' ? '1' : field.type === 'date' ? '2000-01-01' : field.type === 'boolean' ? false :
      field.type === 'select' ? field.options.find(option => !field.disabled_options.includes(option))! : 'قبول البحث'])) };
}

async function write(page: Page, route: string, method: string, payload: object) {
  if (route === 'students' && method === 'POST') {
    const custom = await requiredCustomFields(page);
    payload = { custom_values: custom.values, custom_fields_revision: custom.revision, ...payload };
  }
  const result = await page.evaluate(async ({ route, method, payload }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find((part) => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
  if (route === 'students' && result.status === 201) studentIds.add(result.body.student.id);
  return result;
}

async function workspace(page: Page) {
  return await (await page.request.get(`${host}/api/v1/center/student-search-workspace`)).json() as StudentSearchContext;
}

async function restorePolicy(page: Page, enabled: boolean) {
  const current = await workspace(page);
  if (current.policy.enabled !== enabled) expect((await write(page, 'student-search-policy', 'PATCH', { enabled, revision: current.policy.revision })).status).toBe(200);
}

async function budget(page: Page, url: string, cold: boolean) {
  if (cold) execFileSync(php, ['artisan', 'cache:clear', '--no-interaction'], { cwd: apiDirectory, stdio: 'pipe' });
  const cursor = Number(execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;`], { cwd: apiDirectory, stdio: 'pipe' }).toString().trim());
  const response = await page.goto(workspaceUrl(page, url));
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('searchbox', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل' })).toBeVisible();
  const metrics = () => JSON.parse(execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
    $requests = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_SEARCH_CURSOR'))
      ->whereRaw("content::jsonb->'headers'->>'host' = ?", [getenv('COURSES_SEARCH_REQUEST_HOST')])->get(['batch_id', 'content']);
    $queries = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->where('type', 'query')
      ->whereIn('batch_id', $requests->pluck('batch_id'))->pluck('content')->map(fn($content) => json_decode($content,true));
    $headers = $requests->map(fn($row) => json_decode($row->content,true)['response_headers']);
    echo json_encode(['requests' => $requests->count(), 'recorded' => $queries->count(),
      'counted' => $headers->sum(fn($header) => (int) ($header['x-courses-query-count'] ?? -1)),
      'valid' => $headers->every(fn($header) => (int) ($header['x-courses-query-count'] ?? -1) > 0),
      'connections' => $queries->filter(fn($query) => in_array($query['connection'], ['central','tenant']))->count()]);
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_SEARCH_CURSOR: String(cursor), COURSES_SEARCH_REQUEST_HOST: new URL(host).host }, stdio: 'pipe' }).toString().trim()) as { requests: number; counted: number; recorded: number; valid: boolean; connections: number };
  await expect.poll(() => metrics().requests).toBeGreaterThan(0);
  const result = metrics();
  expect(result.valid).toBe(true); expect(result.recorded).toBe(result.counted); expect(result.connections).toBe(result.counted); expect(result.counted).toBeLessThanOrEqual(6);
}

test.beforeAll(async ({ browser }) => { test.setTimeout(180_000); await ensureLocalFixtures(browser); mkdirSync('/tmp/courses-issue22', { recursive: true }); });

test.afterEach(() => {
  if (!studentIds.size) return;
  execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Local cleanup only');
    $ids = json_decode(getenv('COURSES_SEARCH_IDS'), true, flags: JSON_THROW_ON_ERROR);
    foreach ($ids as $id) if (!\Illuminate\Support\Str::isUuid($id)) throw new \RuntimeException('Unexpected id');
    \App\Models\Center::where('slug','alpha')->firstOrFail()->run(function() use ($ids) {
      \Illuminate\Support\Facades\DB::transaction(function() use ($ids) {
        foreach (\Illuminate\Support\Facades\DB::table('students')->whereIn('id',$ids)->get() as $row)
          if (!preg_match('/^بحث قبول [0-9]{13}/u',$row->name)) throw new \RuntimeException('Unexpected fixture');
        \Illuminate\Support\Facades\DB::table('center_audit_logs')->whereIn(\Illuminate\Support\Facades\DB::raw("details->>'student_id'"),$ids)->delete();
        \Illuminate\Support\Facades\DB::table('student_custom_field_history')->whereIn('student_id',$ids)->delete();
        \Illuminate\Support\Facades\DB::table('student_custom_field_values')->whereIn('student_id',$ids)->delete();
        \Illuminate\Support\Facades\DB::table('student_branches')->whereIn('student_id',$ids)->delete();
        \Illuminate\Support\Facades\DB::table('students')->whereIn('id',$ids)->delete();
      });
    });
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_SEARCH_IDS: JSON.stringify([...studentIds]) }, stdio: 'pipe' });
  studentIds.clear();
});

test('student lookup keeps one field, scopes and barcode mode in the URL', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = credentials('alpha');
  await signIn(page, host, owner.email, owner.password);
  const initial = (await workspace(page)).policy.enabled;
  try {
    await restorePolicy(page, true);
    const members = await (await page.request.get(`${host}/api/v1/center/member-workspace`)).json() as MemberContext;
    const north = members.branches.find((branch) => branch.slug === 'north')!.id;
    const name = `بحث قبول ${Date.now()}`;
    const created = await write(page, 'students', 'POST', { name, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(created.status).toBe(201);

    await budget(page, `${host}/admin/students?q=${encodeURIComponent(name)}`, true);
    await budget(page, `${host}/admin/students?q=${encodeURIComponent(name)}`, false);
    await page.goto(workspaceUrl(page, `${host}/admin/students`));
    await expect(page.getByRole('searchbox')).toHaveCount(1);
    await expect(page.getByRole('table')).toHaveCount(1);
    const search = page.getByRole('searchbox', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل' });
    await search.fill(name); await search.press('Enter');
    await expect(page).toHaveURL(/scope=branches&q=/);
    const resultRow = page.getByRole('row').filter({ hasText: name });
    await resultRow.getByRole('button', { name: `إجراءات الطالب ${name}`, exact: true }).click();
    const profileAction = page.getByRole('menuitem', { name: 'عرض الملف', exact: true });
    await expect(profileAction).toBeVisible();
    await expectWorkspaceHref(page, profileAction, `/admin/students/${created.body.student.id}`);
    await page.keyboard.press('Escape');

    await page.getByRole('combobox', { name: 'طريقة البحث' }).click();
    await page.getByRole('option', { name: /الرقم الداخلي أو/ }).click();
    await expect(page).toHaveURL(/mode=identifier/);
    await expect(page.getByRole('table')).toHaveCount(0);
    const barcode = page.getByRole('searchbox', { name: 'رقم الطالب الداخلي أو الباركود' });
    await barcode.fill(String(created.body.student.student_number)); await barcode.press('Enter');
    await expect(page).toHaveURL(/identifier=/);
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();

    await page.getByRole('radio', { name: 'كل المركز' }).click();
    await expect(page).toHaveURL(/scope=center/);
    await expect(page.getByRole('table')).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/mode=identifier.*identifier=/);
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();

    const legacy = await page.goto(workspaceUrl(page, `${host}/admin/student-search?q=${encodeURIComponent(name)}&page=2`));
    expect(legacy?.status()).toBe(200);
    await expect(page).toHaveURL(/\/admin\/students\?scope=center&q=.*&page=2/);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('radio', { name: 'فروعي' })).toBeVisible();
  } finally { await restorePolicy(page, initial); }
});

test('center search management confirms visibility, recovers stale and uncertain writes and stays within six SSR queries', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = credentials('alpha');
  await signIn(page, host, owner.email, owner.password);
  const initial = (await workspace(page)).policy.enabled;
  try {
    await restorePolicy(page, false);
    await page.goto(workspaceUrl(page, `${host}/admin/students`));
    await expect(page.getByRole('radio', { name: 'كل المركز', exact: true })).toBeDisabled();
    await expect(page.getByRole('searchbox', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل' })).toBeEnabled();
    await page.goto(workspaceUrl(page, `${host}/admin/settings?tab=students`));
    const toggle = page.getByRole('checkbox', { name: 'تفعيل البحث بين الفروع', exact: true });
    await toggle.click();
    const dialog = page.getByRole('alertdialog', { name: 'تفعيل البحث بين الفروع' });
    await expect(dialog.getByRole('button', { name: 'إلغاء', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(toggle).toBeFocused();
    await toggle.click();
    await dialog.getByRole('button', { name: 'تفعيل البحث', exact: true }).click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText('فُعّل البحث بين الفروع.', { exact: true })).toHaveCount(0);
    await restorePolicy(page, false);
    const current = (await workspace(page)).policy;
    const before = await (await page.request.get(`${host}/api/v1/center/audit`)).json();
    const auditCursor = Math.max(0, ...before.entries.map((entry: { id: number }) => entry.id));
    const retries = await Promise.all([write(page, 'student-search-policy', 'PATCH', { enabled: true, revision: current.revision }), write(page, 'student-search-policy', 'PATCH', { enabled: true, revision: current.revision })]);
    expect(retries.map((result) => result.status)).toEqual([200, 200]);
    expect(retries[0].body.policy.revision).toBe(current.revision + 1);
    expect(retries[1].body.policy.revision).toBe(current.revision + 1);
    const after = await (await page.request.get(`${host}/api/v1/center/audit`)).json();
    expect(after.entries.filter((entry: { id: number; event: string }) => entry.id > auditCursor && entry.event === 'center.student_search_changed')).toHaveLength(1);
    await budget(page, `${host}/admin/students?scope=center&q=غيرمطابق`, true);
    await budget(page, `${host}/admin/students?scope=center&q=غيرمطابق`, false);
    await page.getByRole('button', { name: 'مسح البحث في نتائج البحث', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل' })).toBeFocused();
    await page.goto(workspaceUrl(page, `${host}/admin/settings?tab=students`));
    // Keep this open snapshot while another protected request changes policy twice.
    const old = (await workspace(page)).policy;
    expect((await write(page, 'student-search-policy', 'PATCH', { enabled: false, revision: old.revision })).status).toBe(200);
    expect((await write(page, 'student-search-policy', 'PATCH', { enabled: true, revision: old.revision + 1 })).status).toBe(200);
    await page.getByRole('checkbox', { name: 'تفعيل البحث بين الفروع', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'تعطيل البحث', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'تغيّر إعداد البحث' })).toBeVisible();
    await page.getByRole('button', { name: 'تحميل أحدث إعداد للبحث' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'حُمّل أحدث إعداد' })).toBeVisible();
    await page.route('**/api/v1/center/student-search-policy', async (route) => {
      if (route.request().method() === 'PATCH') { await route.fetch(); await route.abort('connectionfailed'); await page.unroute('**/api/v1/center/student-search-policy'); }
      else await route.continue();
    });
    await page.getByRole('checkbox', { name: 'تفعيل البحث بين الفروع', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'تعطيل البحث', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'تعذر التأكد من حفظ الإعداد' })).toBeVisible();
    await page.getByRole('button', { name: 'تحميل أحدث إعداد للبحث' }).click();
    await expect(page.getByRole('checkbox', { name: 'تفعيل البحث بين الفروع', exact: true })).not.toBeChecked();
    const light = page.getByRole('button', { name: 'تفعيل الوضع الفاتح' });
    if (await light.count()) await light.click();
    await page.screenshot({ path: '/tmp/courses-issue22/search-light.png', fullPage: true });
    const dark = page.getByRole('button', { name: 'تفعيل الوضع الداكن' });
    if (await dark.count()) await dark.click();
    await page.screenshot({ path: '/tmp/courses-issue22/search-dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/courses-issue22/search-mobile.png', fullPage: true });
    await page.goto(workspaceUrl(page, `${host}/admin/audit`));
    await page.getByText('عرض تغيير إتاحة البحث', { exact: true }).first().click();
    await expect(page.getByText('بعد التغيير: مغلق', { exact: true }).first()).toBeVisible();
  } finally { await restorePolicy(page, initial); }
});

test('search and similarity reveal basic data only and lose revoked cross-branch access on the next request', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await browser.newPage(); const staff = await browser.newPage(); const beta = await browser.newPage();
  let original: MemberContext['members'][number] | undefined; let initialPolicy: StudentSearchPolicy | undefined; let originalAllBranches: boolean | undefined;
  try {
    const ownerCredentials = credentials('alpha'); const staffCredentials = credentials('staff'); const betaCredentials = credentials('beta');
    await signIn(owner, host, ownerCredentials.email, ownerCredentials.password);
    initialPolicy = (await workspace(owner)).policy;
    const members = await (await owner.request.get(`${host}/api/v1/center/member-workspace`)).json() as MemberContext;
    original = members.members.find((member) => member.user.email === staffCredentials.email)!;
    const north = members.branches.find((branch) => branch.slug === 'north')!.id; const south = members.branches.find((branch) => branch.slug === 'south')!.id;
    await restorePolicy(owner, true);
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north]: ['registration', 'center_student_search'] } })).status).toBe(200);
    const settings = await (await owner.request.get(`${host}/api/v1/center/settings`)).json();
    originalAllBranches = settings.settings.student_all_branches_enabled;
    if (originalAllBranches) expect((await write(owner, 'student-branch-settings', 'PATCH', { enabled: false, revision: settings.settings.student_all_branches_revision })).status).toBe(200);
    const name = `بحث قبول ${Date.now()}`;
    const hidden = await write(owner, 'students', 'POST', { name, phone: '01099007766', branch_ids: [south], request_id: crypto.randomUUID() });
    expect(hidden.status).toBe(201);
    expect(hidden.body.student.branch_ids).toEqual([south]);
    if (!hidden.body.student.sharing_enabled) expect((await write(owner, `students/${hidden.body.student.id}/sharing`, 'PATCH', { sharing_enabled: true, revision: hidden.body.student.revision })).status).toBe(200);
    await signIn(staff, host, staffCredentials.email, staffCredentials.password);
    await staff.goto(workspaceUrl(staff, `${host}/admin/students?scope=center`));
    await expect(staff.getByRole('tab', { name: 'الطلاب', exact: true })).toHaveCount(0);
    await staff.getByRole('searchbox', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل' }).fill(name);
    await staff.getByRole('button', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل', exact: true }).click();
    const row = staff.getByRole('row').filter({ hasText: name }); await expect(row).toBeVisible();
    await expect(staff.getByRole('tab', { name: 'الطلاب', exact: true })).toHaveCount(0);
    await expect(staff.getByRole('status').filter({ hasText: 'البحث بين الفروع مغلق' })).toHaveCount(0);
    await staff.screenshot({ path: '/tmp/courses-issue22/search-results.png', fullPage: true });
    await expect(row).toContainText('بيانات أساسية فقط'); await expect(row.getByRole('link')).toHaveCount(0);
    expect((await staff.request.get(`${host}/api/v1/center/students/${hidden.body.student.id}`)).status()).toBe(404);
    expect((await write(staff, `students/${hidden.body.student.id}`, 'PATCH', { name: 'Denied', branch_ids: [north], revision: 1 })).status).toBe(404);
    await staff.goto(workspaceUrl(staff, `${host}/admin/students`));
    const createLink = staff.getByRole('link', { name: 'إنشاء ملف طالب', exact: true });
    await expectWorkspaceHref(staff, createLink, '/admin/students/new');
    await createLink.click();
    await staff.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(name);
    const custom = await requiredCustomFields(staff);
    for (const field of custom.fields) {
      const input = staff.locator(`[id$="-custom-${field.id}"]`);
      if (field.type === 'select' || field.type === 'boolean') {
        await input.click();
        await staff.getByRole('option', { name: field.type === 'boolean' ? 'لا' : String(custom.values[field.id]), exact: true }).click();
      } else await input.fill(String(custom.values[field.id]));
    }
    await staff.getByRole('link', { name: 'الطلاب', exact: true }).click();
    await expect(staff.getByRole('alertdialog', { name: 'مغادرة دون حفظ' })).toBeVisible();
    await staff.getByRole('alertdialog').getByRole('button', { name: 'إلغاء', exact: true }).click();
    await expect(staff.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toHaveValue(name);
    await staff.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
    const warning = staff.getByRole('status').filter({ hasText: 'توجد ملفات ببيانات متشابهة' });
    await expect(warning).toContainText(name); await expect(warning.getByRole('link')).toHaveCount(0);
    await staff.locator('.center-topbar').getByRole('link', { name: 'إلغاء', exact: true }).click();
    await staff.getByRole('alertdialog', { name: 'مغادرة دون حفظ' }).getByRole('button', { name: 'مغادرة دون حفظ', exact: true }).click();
    await expect(staff.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toHaveCount(0);
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north]: ['registration'] } })).status).toBe(200);
    expect((await staff.request.get(`${host}/api/v1/center/student-search-workspace?q=${encodeURIComponent(name)}`)).status()).toBe(403);
    const similar = await (await staff.request.get(`${host}/api/v1/center/students/similar?name=${encodeURIComponent(name)}`)).json(); expect(similar.students).toHaveLength(0);
    expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north]: ['registration', 'center_student_search'] } })).status).toBe(200);
    await restorePolicy(owner, false);
    const disabled = await (await staff.request.get(`${host}/api/v1/center/student-search-workspace?q=${encodeURIComponent(name)}`)).json(); expect(disabled.students).toHaveLength(0);
    await signIn(beta, 'http://beta.courses.test', betaCredentials.email, betaCredentials.password);
    const elsewhere = await (await beta.request.get(`http://beta.courses.test/api/v1/center/student-search-workspace?q=${encodeURIComponent(name)}`)).json(); expect(elsewhere.students).toHaveLength(0);
    expect((await owner.request.get(`${host}/api/v1/center/students/${hidden.body.student.id}`)).ok()).toBe(true);
  } catch (error) { console.error('Original protected-journey failure:', error); throw error; } finally {
    if (original) expect((await write(owner, `members/${original.id}/grants`, 'PUT', { center_roles: original.center_roles, branch_roles: original.branch_roles })).status).toBe(200);
    if (originalAllBranches !== undefined) {
      const currentSettings = await (await owner.request.get(`${host}/api/v1/center/settings`)).json();
      if (currentSettings.settings.student_all_branches_enabled !== originalAllBranches) expect((await write(owner, 'student-branch-settings', 'PATCH', { enabled: originalAllBranches, revision: currentSettings.settings.student_all_branches_revision })).status).toBe(200);
    }
    if (initialPolicy) await restorePolicy(owner, initialPolicy.enabled);
    await Promise.all([owner.close(), staff.close(), beta.close()]);
  }
});

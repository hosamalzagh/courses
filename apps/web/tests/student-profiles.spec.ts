import { finishWorkspaceEntry, expectWorkspaceUrl, expectWorkspaceHref, workspaceUrl } from "./workspace-testhelpers";
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { credentials as localCredentials, ensureLocalFixtures, signIn as signInLocal } from './local-fixtures';
import type { StudentCustomFieldContext } from '@/lib/server-context';

const php = process.env.COURSES_PHP_BIN ?? (process.platform === 'darwin' ? 'php85' : 'php');
const apiDirectory = path.resolve(process.cwd(), '../api');
const createdStudentIds = new Set<string>();
const createdBetaStudentIds = new Set<string>();
const createdProfileBranches = new Map<number, string>();
const fixtureFile = process.env.COURSES_PROFILE_FIXTURE_FILE;
const host = process.env.COURSES_PROFILE_TEST_ORIGIN ?? 'http://alpha.courses.test';
const betaHost = host.replace('alpha.', 'beta.');
const artifacts = process.env.COURSES_PROFILE_ARTIFACTS;
const fixture = fixtureFile ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : undefined;
const sessions: Partial<Record<'alpha' | 'beta' | 'staff', Awaited<ReturnType<BrowserContext['storageState']>>>> = {};
const credentials = (name: 'alpha' | 'beta' | 'staff') => fixture?.[name] ?? localCredentials(name);

test('creation and edit load branch choices beyond the first fifty without losing inputs', async ({ page }) => {
  await signIn(page, 'beta');
  let lastBranch: { id: number; name: string } | undefined;
  const branchIds: number[] = [];
  for (let index = 0; index < 51; index++) {
    const result = await write(page, 'branches', 'POST', { name: `فرع إضافي ${Date.now()} ${index}`, slug: `profile-${Date.now()}-${index}` });
    expect(result.status).toBe(201); lastBranch = result.body.branch; branchIds.push(lastBranch!.id);
    createdProfileBranches.set(lastBranch!.id, result.body.branch.slug);
  }
  await page.goto(workspaceUrl(page, `${betaHost}/admin/students/new`));
  const name = `طالب فروع ${Date.now()}`;
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(name);
  await fillRequiredCustomFields(page);
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('مدرسة محفوظة أثناء التحميل');
  while (await page.getByRole('button', { name: 'تحميل المزيد من الفروع', exact: true }).count()) {
    const response = page.waitForResponse((response) => response.url().includes('student-workspace?branches_page='));
    await page.getByRole('button', { name: 'تحميل المزيد من الفروع', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(page.locator('button[aria-busy="true"]')).toHaveCount(0);
  }
  await page.getByRole('checkbox', { name: lastBranch!.name, exact: true }).check();
  await expect(page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true })).toHaveValue('مدرسة محفوظة أثناء التحميل');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/students') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  const student = (await (await saved).json()).student;
  createdBetaStudentIds.add(student.id);
  expect(student.branch_ids).toContain(lastBranch!.id);
  const expanded = await write(page, `students/${student.id}`, 'PATCH', { name, branch_ids: branchIds.slice(0, 50), revision: student.revision });
  expect(expanded.status).toBe(200); expect(expanded.body.student.branch_ids.length).toBeGreaterThan(50);
  await expectWorkspaceUrl(page, `/admin/students/${student.id}?focus=edit`);
  await page.goto(workspaceUrl(page, `${betaHost}/admin/students/${student.id}/edit`));
  await page.getByRole('textbox', { name: 'جهة العمل', exact: true }).fill('جهة محفوظة أثناء التحميل');
  while (await page.getByRole('button', { name: 'تحميل المزيد من الفروع', exact: true }).count()) {
    const response = page.waitForResponse((response) => response.url().includes('student-workspace?branches_page='));
    await page.getByRole('button', { name: 'تحميل المزيد من الفروع', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(page.locator('button[aria-busy="true"]')).toHaveCount(0);
  }
  await expect(page.getByRole('checkbox', { name: `${lastBranch!.name} — مرتبط بالفعل`, exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}?focus=edit`);
  const current = (await (await page.request.get(`${betaHost}/api/v1/center/students/${student.id}`, { headers: { "X-Courses-Workspace": new URL(page.url()).searchParams.get("workspace")! } })).json()).students[0];
  expect(current.branch_ids).toContain(lastBranch!.id); expect(current.employer).toBe('جهة محفوظة أثناء التحميل');
});

async function profileAction(page: Page, name: string, id: string) {
  await page.getByRole('button', { name: `إجراءات الطالب ${name}`, exact: true }).click();
  const action = page.getByRole('menuitem', { name: 'عرض الملف', exact: true });
  await expectWorkspaceHref(page, action, `/admin/students/${id}`);
  return action;
}

test('cached student editors keep unique native submit ownership', async ({ page }) => {
  await signIn(page);
  const prefix = `طالب قبول ${Date.now()} ربط النموذج`;
  const first = await create(page, `${prefix} أ`);
  const second = await create(page, `${prefix} ب`);
  await page.getByRole('link', { name: 'العودة إلى ملفات الطلاب', exact: true }).click();
  await page.getByRole('searchbox', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل', exact: true }).fill(prefix);
  await page.getByRole('button', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل', exact: true }).click();
  await (await profileAction(page, `${prefix} أ`, first.id)).click();
  await expectWorkspaceUrl(page, `${host}/admin/students/${first.id}`);
  await page.locator('.center-topbar').getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click();
  const firstFormId = await page.locator('.center-topbar').getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).getAttribute('form');
  await page.locator('.center-topbar').getByRole('link', { name: 'إلغاء', exact: true }).click();
  await page.getByRole('link', { name: 'العودة إلى ملفات الطلاب', exact: true }).click();
  await page.getByRole('searchbox', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل', exact: true }).fill(prefix);
  await page.getByRole('button', { name: 'الاسم أو رقم الطالب الداخلي أو رقم التواصل', exact: true }).click();
  await (await profileAction(page, `${prefix} ب`, second.id)).click();
  await expectWorkspaceUrl(page, `${host}/admin/students/${second.id}`);
  await page.locator('.center-topbar').getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click();
  const save = page.locator('.center-topbar').getByRole('button', { name: 'حفظ بيانات الطالب', exact: true });
  const secondFormId = await save.getAttribute('form');
  expect(secondFormId).not.toBe(firstFormId);
  expect(await save.evaluate((button) => (button as HTMLButtonElement).form?.getAttribute('aria-label'))).toBe(`تعديل ملف ${prefix} ب`);
  await expect(page.locator(`form[id="${secondFormId}"]`)).toHaveCount(1);
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`${prefix} ب معدل`);
  await save.click();
  await expectWorkspaceUrl(page, `/admin/students/${second.id}?focus=edit`);
  const a = (await (await page.request.get(`${host}/api/v1/center/students/${first.id}`)).json()).students[0];
  const b = (await (await page.request.get(`${host}/api/v1/center/students/${second.id}`)).json()).students[0];
  expect(a.name).toBe(`${prefix} أ`);
  expect(b.name).toBe(`${prefix} ب معدل`);
});

test('combined profile keeps number and sharing through suspension, general edits and browser Back', async ({ page }) => {
  await signIn(page);
  const settings = (await (await page.request.get(`${host}/api/v1/center/settings`)).json()).settings;
  expect((await write(page,'student-code-settings','PATCH',{enabled:true,label:'كارت التكامل',revision:settings.student_code_revision})).status).toBe(200);
  const integrationPhone=`000${Date.now()}`;
  const manualCode=`000-INTEGRATION-${Date.now()}`;
  const customLabel=`CUSTOM62 integration ${Date.now()}`;
  const customField=await write(page,'student-custom-fields','POST',{id:crypto.randomUUID(),label:customLabel,type:'text',required:false,position:0,options:[]});expect(customField.status).toBe(201);
  const start = Date.now() * 100;
  expect((await write(page, 'student-numbering', 'PATCH', { start, revision: settings.student_number_revision })).status).toBe(200);
  const policy = (await (await page.request.get(`${host}/api/v1/center/student-search-workspace`)).json()).policy;
  expect((await write(page, 'student-search-policy', 'PATCH', { enabled: true, default_sharing_enabled: true, revision: policy.revision })).status).toBe(200);
  const student = await create(page, `طالب قبول ${Date.now()} تكامل`, {label:'كارت التكامل',value:manualCode}, '000-INTEGRATION-PASSPORT', {label:customLabel,value:'000-INTEGRATION-CUSTOM'});
  expect(student.student_number).toBe(start);
  await expect(page.getByText('المشاركة بين الفروع: مسموحة', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'تغيير مشاركة الطالب', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'غلق مشاركة الطالب', exact: true }).click();
  await expect(page.getByText('المشاركة بين الفروع: مغلقة', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'إيقاف ملف الطالب', exact: true }).click();
  await page.getByRole('textbox', { name: 'سبب تغيير الحالة' }).fill('إيقاف قبول التكامل');
  await page.getByRole('button', { name: 'إيقاف ملف الطالب', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'إيقاف ملف الطالب', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'حالة ملف الطالب: موقوف' })).toBeVisible();
  await page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click();
  await enterContact(page, integrationPhone);
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('مدرسة التكامل');
  await page.goBack();
  await expect(page.getByRole('alertdialog')).toContainText('مغادرة دون حفظ');
  await page.getByRole('alertdialog').getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true })).toHaveValue('مدرسة التكامل');
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}?focus=edit`);
  const current = (await (await page.request.get(`${host}/api/v1/center/students/${student.id}`)).json()).students[0];
  expect(current.student_number).toBe(start); expect(current.school).toBe('مدرسة التكامل');
  expect(current.sharing_enabled).toBe(false); expect(current.status).toBe('suspended');
  expect(current.manual_code).toBe(manualCode);
  expect(current.identity.passport_number).toBe('000-INTEGRATION-PASSPORT');
  for (let batch=1; ; batch++) {
    const data=await (await page.request.get(`${host}/api/v1/center/student-custom-fields?student_id=${student.id}&page=${batch}`)).json();
    if (Object.hasOwn(data.values,customField.body.field.id)) {expect(data.values[customField.body.field.id]).toBe('000-INTEGRATION-CUSTOM');break;}
    expect(data.pagination.has_more).toBe(true);
  }
  expect(current.contacts[0].phone).toBe(integrationPhone); expect(current.contacts[0].name).toBe('صاحب الرقم المشترك');
  const barcode = await page.request.get(`${host}/api/v1/center/students/${student.id}/barcode`);
  expect(barcode.status()).toBe(200); expect(await barcode.text()).toContain(String(start));
  expect(await barcode.text()).not.toContain('مدرسة التكامل');
  await page.getByRole('button', { name: 'فك إيقاف ملف الطالب', exact: true }).click();
  await page.getByRole('textbox', { name: 'سبب تغيير الحالة' }).fill('عودة قبول التكامل');
  await page.getByRole('button', { name: 'فك إيقاف ملف الطالب', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'فك إيقاف ملف الطالب', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'حالة ملف الطالب: نشط' })).toBeVisible();
  await expect(page.getByText('المشاركة بين الفروع: مغلقة', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click();
  await page.getByRole('link', { name: 'إلغاء', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}?focus=edit`);
  await page.goBack();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('تعديل لم يُحفظ');
  await page.goForward();
  await expect(page.getByRole('alertdialog')).toContainText('مغادرة دون حفظ');
  await page.getByRole('alertdialog').getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true })).toHaveValue('تعديل لم يُحفظ');
  await page.evaluate(() => history.go(-2));
  await expect(page.getByRole('alertdialog')).toContainText('مغادرة دون حفظ');
  await page.getByRole('alertdialog').getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true })).toHaveValue('تعديل لم يُحفظ');
  await page.goForward();
  await page.getByRole('alertdialog').getByRole('button', { name: 'مغادرة دون حفظ', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}?focus=edit`);
  expect((await (await page.request.get(`${host}/api/v1/center/students/${student.id}`)).json()).students[0].school).toBe('مدرسة التكامل');
  await page.goBack();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}/edit`);
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('تعديل بعد العودة');
  await page.goBack();
  await expect(page.getByRole('alertdialog')).toContainText('مغادرة دون حفظ');
  await page.getByRole('alertdialog').getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true })).toHaveValue('تعديل بعد العودة');
});

function measureCursor(): number {
  if (process.env.COURSES_PROFILE_READ_LOG) return readFileSync(process.env.COURSES_PROFILE_READ_LOG, 'utf8').trim().split('\n').length;
  return Number(execFileSync(php, ['artisan', 'tinker', '--no-interaction', String.raw`--execute=echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;`], {cwd:apiDirectory,stdio:'pipe'}).toString().trim());
}

function measuredReads(cursor: number): {count: number | null}[] {
  if (process.env.COURSES_PROFILE_READ_LOG) return readFileSync(process.env.COURSES_PROFILE_READ_LOG, 'utf8').trim().split('\n').slice(cursor).map((row) => JSON.parse(row));
  return JSON.parse(execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
    echo json_encode(\Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TEST_CURSOR'))
      ->whereRaw("content::jsonb->'headers'->>'host' = ?", [getenv('COURSES_TEST_HOST')])
      ->pluck('content')->map(function ($row) {
        $count = json_decode($row, true)['response_headers']['x-courses-query-count'] ?? null;
        return ['count' => $count === null ? null : (int) $count];
      })->all());
  `], {cwd:apiDirectory,env:{...process.env,COURSES_TEST_CURSOR:String(cursor),COURSES_TEST_HOST:new URL(host).host},stdio:'pipe'}).toString().trim());
}

async function signIn(page: Page, name: 'alpha' | 'beta' | 'staff' = 'alpha') {
  const owner = credentials(name);
  const session = sessions[name];
  if (session) {
    await page.context().addCookies(session.cookies);
    await page.goto(`${name === 'beta' ? betaHost : host}/admin`);
    await finishWorkspaceEntry(page);
    await expectWorkspaceUrl(page, "/admin");
    return;
  }
  if (!fixtureFile) {
    await signInLocal(page, name === 'beta' ? betaHost : host, owner.email, owner.password);
    await expectWorkspaceUrl(page, "/admin");
    return;
  }
  await page.goto(`${name === 'beta' ? betaHost : host}/login`);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(owner.email);
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).fill(owner.password);
  await page.getByRole('button', { name: 'دخول المركز', exact: true }).click();
  await finishWorkspaceEntry(page);
  await expectWorkspaceUrl(page, "/admin");
}

async function requiredCustomFields(page: Page) {
  const origin = new URL(page.url()).origin;
  const workspace = new URL(page.url()).searchParams.get('workspace');
  if (!workspace) throw new Error('Required-field fixtures need a selected workspace');
  const fields: StudentCustomFieldContext['fields'] = [];
  let current: StudentCustomFieldContext;
  let batch = 1;
  do {
    const response = await page.request.get(`${origin}/api/v1/center/student-custom-fields?page=${batch++}`, { headers: { 'X-Courses-Workspace': workspace } });
    expect(response.status()).toBe(200);
    current = await response.json() as StudentCustomFieldContext;
    fields.push(...current.fields.filter(field => field.active && field.required));
  } while (current.pagination.has_more);
  const values = Object.fromEntries(fields.map(field => {
    const value = field.type === 'number' ? '1' : field.type === 'date' ? '2000-01-01' : field.type === 'boolean' ? false : field.type === 'select' ? field.options.find(option => !field.disabled_options.includes(option)) : 'قبول الملف';
    if (value === undefined) throw new Error(`Required fixture field has no enabled choice: ${field.label}`);
    return [field.id, value];
  }));
  return { fields, values, revision: current.revision };
}

async function fillRequiredCustomFields(page: Page) {
  const custom = await requiredCustomFields(page);
  const group = page.getByRole('group', { name: 'الحقول الإضافية', exact: true });
  for (const field of custom.fields) {
    const choice = field.type === 'select' || field.type === 'boolean';
    const input = group.getByRole(choice ? 'combobox' : 'textbox', { name: choice ? `${field.label} (مطلوب)` : field.label, exact: true });
    while (!await input.count()) {
      const load = page.locator('.center-topbar').getByRole('button', { name: 'تحميل المزيد من الحقول', exact: true });
      await expect(load).toBeVisible();
      const before = await group.locator('[data-slot="field"], p').count();
      const loaded = page.waitForResponse(response => response.url().includes('/api/v1/center/student-custom-fields?') && response.request().method() === 'GET');
      await load.click();
      expect((await loaded).status()).toBe(200);
      await expect.poll(() => group.locator('[data-slot="field"], p').count()).toBeGreaterThan(before);
    }
    if (choice) {
      await input.click();
      await page.getByRole('option', { name: field.type === 'boolean' ? 'لا' : String(custom.values[field.id]), exact: true }).click();
    } else await input.fill(String(custom.values[field.id]));
  }
}

async function write(page: Page, route: string, method: string, payload: object) {
  if (route === 'students' && method === 'POST') {
    const custom = await requiredCustomFields(page);
    payload = { custom_values: custom.values, custom_fields_revision: custom.revision, ...payload };
  }
  const result = await page.evaluate(async ({ route, method, payload }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find((part) => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const workspace = new URL(window.location.href).searchParams.get('workspace');
    if (!workspace) throw new Error('Manual fixture writes require a selected workspace URL');
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? ''), 'X-Courses-Workspace': workspace }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
  if (route === 'students' && result.status === 201) {
    const ids = new URL(page.url()).origin === new URL(betaHost).origin ? createdBetaStudentIds : createdStudentIds;
    ids.add(result.body.student.id);
  }
  return result;
}

async function create(page: Page, name: string, code?: {label:string;value:string}, passport?: string, custom?: {label:string;value:string}) {
  await page.goto(workspaceUrl(page, `${host}/admin/students/new`));
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(name);
  await fillRequiredCustomFields(page);
  if (code) await page.getByRole('textbox',{name:code.label,exact:true}).fill(code.value);
  if (custom) {
    while (!(await page.getByRole('textbox',{name:custom.label,exact:true}).count())) {
      const before=await page.locator('[data-slot="field"]').count();
      await page.getByRole('button',{name:'تحميل المزيد من الحقول',exact:true}).click();
      await expect.poll(()=>page.locator('[data-slot="field"]').count()).toBeGreaterThan(before);
    }
    await page.getByRole('textbox',{name:custom.label,exact:true}).fill(custom.value);
  }
  if (passport) await page.getByRole('textbox',{name:'رقم جواز السفر',exact:true}).fill(passport);
  const response = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/students') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  const student = (await (await response).json()).student;
  createdStudentIds.add(student.id);
  await expectWorkspaceUrl(page, `/admin/students/${student.id}?focus=edit`);
  return student;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  if (!fixtureFile) await ensureLocalFixtures(browser);
  // Reuse sessions obtained through real sign-in, without disabling authentication or its rate limit.
  for (const name of ['alpha', 'beta', 'staff'] as const) {
    const page = await browser.newPage();
    await signIn(page, name);
    sessions[name] = await page.context().storageState();
    await page.close();
  }
});

test.afterEach(() => {
  if (!createdStudentIds.size && !createdBetaStudentIds.size && !createdProfileBranches.size) return;
  execFileSync(php, ['artisan', 'tinker', '--no-interaction', '--execute=' + String.raw`
    $isolated = getenv('COURSES_PROFILE_FIXTURE_FILE') && getenv('COURSES_PROFILE_DB_PORT') && (string) config('database.connections.central.port') === getenv('COURSES_PROFILE_DB_PORT') && (string) config('database.connections.central.port') !== '5432' && config('database.connections.central.host') === '127.0.0.1';
    if (getenv('COURSES_PROFILE_FIXTURE_FILE') && !$isolated) throw new \RuntimeException('Isolated profile fixture connection required');
    if (!app()->isLocal() || (!$isolated && config('database.connections.central.database') !== 'courses_central')) throw new \RuntimeException('Local fixture cleanup only');
    $students = json_decode(getenv('COURSES_TEST_STUDENT_IDS'), true, flags: JSON_THROW_ON_ERROR);
    $branches = json_decode(getenv('COURSES_TEST_PROFILE_BRANCHES'), true, flags: JSON_THROW_ON_ERROR);
    foreach (['alpha', 'beta'] as $slug) {
      $ids = $students[$slug];
      foreach ($ids as $id) if (!\Illuminate\Support\Str::isUuid($id)) throw new \RuntimeException('Unexpected fixture identifier');
      $ownedBranches = $slug === 'beta' ? $branches : [];
      if (!$ids && !$ownedBranches) continue;
      \App\Models\Center::where('slug', $slug)->firstOrFail()->run(function () use ($ids, $slug, $ownedBranches) {
      \Illuminate\Support\Facades\DB::transaction(function () use ($ids, $slug, $ownedBranches) {
        $rows = \Illuminate\Support\Facades\DB::table('students')->whereIn('id', $ids)->get();
        $prefix = $slug === 'beta' ? '/^طالب فروع [0-9]{13}$/u' : '/^(طالب قبول|طالب آخر|محجوب|مصرح|إعادة|متزامن أول|متزامن ثان|استعادة) [0-9]{13}/u';
        foreach ($rows as $row) if (!preg_match($prefix, $row->name)) throw new \RuntimeException('Unexpected student fixture');
        \Illuminate\Support\Facades\DB::table('center_audit_logs')->whereIn(\Illuminate\Support\Facades\DB::raw("details->>'student_id'"), $ids)->delete();
        \Illuminate\Support\Facades\DB::table('student_suspensions')->whereIn('student_id', $ids)->delete();
        \Illuminate\Support\Facades\DB::table('student_custom_field_history')->whereIn('student_id', $ids)->delete();
        \Illuminate\Support\Facades\DB::table('student_custom_field_values')->whereIn('student_id', $ids)->delete();
        \Illuminate\Support\Facades\DB::table('student_branches')->whereIn('student_id', $ids)->delete();
        \Illuminate\Support\Facades\DB::table('students')->whereIn('id', $ids)->delete();
        // Only this run's recorded branches, after removing its student associations.
        foreach ($ownedBranches as $branch) {
          if (!is_int($branch['id']) || $branch['id'] < 1 || !preg_match('/^profile-[0-9]{13}-[0-9]{1,2}$/', $branch['slug'])) throw new \RuntimeException('Unexpected branch fixture identifier');
          $row = \Illuminate\Support\Facades\DB::table('branches')->where('id', $branch['id'])->first();
          if (!$row) continue;
          if ($row->slug !== $branch['slug'] || !preg_match('/^فرع إضافي [0-9]{13} [0-9]{1,2}$/u', $row->name)) throw new \RuntimeException('Unexpected branch fixture');
          \Illuminate\Support\Facades\DB::table('center_audit_logs')->where('branch_id', $row->id)->where('event', 'branch.created')->delete();
          \Illuminate\Support\Facades\DB::table('branches')->where('id', $row->id)->delete();
        }
      });
    });
    }
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_STUDENT_IDS: JSON.stringify({ alpha: [...createdStudentIds], beta: [...createdBetaStudentIds] }), COURSES_TEST_PROFILE_BRANCHES: JSON.stringify([...createdProfileBranches].map(([id, slug]) => ({ id, slug }))) }, stdio: 'pipe' });
  createdStudentIds.clear();
  createdBetaStudentIds.clear();
  createdProfileBranches.clear();
});

test('dedicated creation and edit preserve optional data, focus, validation, dirty navigation and the profile summary', async ({ page }) => {
  await signIn(page);
  await page.goto(workspaceUrl(page, `${host}/admin/students`));
  await page.getByRole('link', { name: 'إنشاء ملف طالب', exact: true }).click();
  await expectWorkspaceUrl(page, "/admin/students/new");
  const name = `طالب قبول ${Date.now()}`;
  await page.getByRole('button', { name: 'حفظ ملف الطالب' }).click();
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(name);
  await fillRequiredCustomFields(page);
  await page.getByRole('textbox', { name: 'تاريخ الميلاد', exact: true }).fill('2099-01-01');
  await page.getByRole('textbox', { name: 'العنوان', exact: true }).fill('شارع المدرسة');
  await page.getByRole('textbox', { name: 'البريد الإلكتروني', exact: true }).fill('student@example.test');
  await page.getByRole('button', { name: 'حفظ ملف الطالب' }).click();
  await expect(page.getByRole('textbox', { name: 'تاريخ الميلاد', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('textbox', { name: 'العنوان', exact: true })).toHaveValue('شارع المدرسة');
  await page.getByRole('textbox', { name: 'تاريخ الميلاد', exact: true }).fill('2016-09-27');
  await page.getByRole('radio', { name: 'أنثى', exact: true }).check();
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('مدرسة القبول');
  await page.getByRole('textbox', { name: 'جهة العمل', exact: true }).fill('جهة القبول');
  await page.getByRole('textbox', { name: 'التخصص', exact: true }).fill('التخصص');
  await fillRequiredCustomFields(page);
  const response = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/students') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'حفظ ملف الطالب' }).click();
  const student = (await (await response).json()).student;
  createdStudentIds.add(student.id);
  await expectWorkspaceUrl(page, `/admin/students/${student.id}?focus=edit`);
  await expect(page.getByRole('heading', { name: 'ملف الطالب', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true })).toBeFocused();
  await expect(page.getByText('مدرسة القبول', { exact: true })).toBeVisible();
  await expect(page.getByText('شارع المدرسة', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}/edit`);
  await page.getByRole('textbox', { name: 'التخصص', exact: true }).fill('تعديل غير محفوظ');
  await page.getByRole('link', { name: 'إلغاء', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'مغادرة دون حفظ' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('link', { name: 'إلغاء', exact: true })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'التخصص', exact: true })).toHaveValue('تعديل غير محفوظ');
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${student.id}?focus=edit`);
  await expect(page.getByText('تعديل غير محفوظ', { exact: true })).toBeVisible();
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'profile-light.png'), fullPage: true });
  await page.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
  await page.getByRole('link', { name:'تعديل ملف الطالب',exact:true }).evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'profile-dark.png'), fullPage: true });
  await page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'form-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: 'إلغاء', exact: true }).click();
  await expect(page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true })).toBeFocused();
  await page.goto(workspaceUrl(page, `${host}/admin/audit`));
  await page.getByText('عرض تغيير ملف الطالب', { exact: true }).first().click();
  await expect(page.getByText('بعد التغيير:', { exact: false }).first()).toContainText('تعديل غير محفوظ');
});

test('stale edits reload current data and a committed creation with a lost response recovers the same file', async ({ page }) => {
  await signIn(page);
  const name = `استعادة ${Date.now()}`;
  await page.goto(workspaceUrl(page, `${host}/admin/students/new`));
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(name);
  await fillRequiredCustomFields(page);
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
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('طلب تغير');
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  // A similarity notice may ask for a second explicit submit.
  if (await page.getByRole('button', { name: 'إنشاء ملف مستقل', exact: true }).isVisible()) await page.getByRole('button', { name: 'إنشاء ملف مستقل', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت بيانات الملف أو الطلب' })).toBeVisible();
  await page.getByRole('button', { name: 'تحميل أحدث بيانات الطالب', exact: true }).click();
  await expect(page.getByRole('textbox', {name:'اسم الطالب',exact:true})).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true })).toHaveValue('');
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('محفوظ');
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expectWorkspaceUrl(page, `/admin/students/${savedId}?focus=edit`);
  const records = await (await page.request.get(`${host}/api/v1/center/student-workspace?q=${encodeURIComponent(name)}`)).json();
  expect(records.students).toHaveLength(1);
  await page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click();
  const currentResponse = await page.request.get(`${host}/api/v1/center/students/${savedId}`, { headers: { 'X-Courses-Workspace': new URL(page.url()).searchParams.get('workspace')! } });
  expect(currentResponse.status()).toBe(200);
  const currentRecord = (await currentResponse.json()).students[0];
  const latest = await write(page, `students/${savedId}`, 'PATCH', { name, branch_ids: currentRecord.branch_ids, revision: 2, school: 'تحديث زميل' });
  expect(latest.status).toBe(200);
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('نسخة قديمة');
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'تغيّرت بيانات الملف أو الطلب' })).toBeVisible();
  await page.getByRole('button', { name: 'تحميل أحدث بيانات الطالب', exact: true }).click();
  await expect(page.getByRole('textbox', {name:'اسم الطالب',exact:true})).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true })).toHaveValue('تحديث زميل');
});

test('branch and center boundaries, permission revocation and parallel submissions remain enforced by real HTTP', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await browser.newPage(); const staff = await browser.newPage(); const beta = await browser.newPage();
  await signIn(owner);
  const workspace = await (await owner.request.get(`${host}/api/v1/center/member-workspace`)).json();
  const north = workspace.branches.find((branch: {slug:string}) => branch.slug === 'north');
  const south = workspace.branches.find((branch: {slug:string}) => branch.slug === 'south');
  const member = workspace.members.find((member: {user:{email:string}}) => member.user.email === credentials('staff').email);
  const stamp = Date.now();
  const hidden = await write(owner, 'students', 'POST', { name: `محجوب ${stamp}`, branch_ids: [south.id], request_id: crypto.randomUUID(), school: 'بيانات محجوبة' });
  const visible = await write(owner, 'students', 'POST', { name: `مصرح ${stamp}`, branch_ids: [north.id,south.id], request_id: crypto.randomUUID() });
  expect(hidden.status).toBe(201); expect(visible.status).toBe(201);
  try {
    expect((await write(owner, `members/${member.id}/grants`, 'PUT', { center_roles: [], branch_roles: { [north.id]: ['registration'] } })).status).toBe(200);
    await signIn(staff, 'staff');
    expect((await staff.request.get(`${host}/api/v1/center/students/${hidden.body.student.id}`)).status()).toBe(404);
    expect((await write(staff, `students/${hidden.body.student.id}`, 'PATCH', { name:'تجاوز', branch_ids:[], revision:1, school:'تجاوز' })).status).toBe(404);
    await staff.goto(workspaceUrl(staff, `${host}/admin/students/${hidden.body.student.id}/edit`));
    await expect(staff.getByRole('heading', { name: 'ملف الطالب غير متاح' })).toBeVisible();
    expect((await write(owner, `members/${member.id}/grants`, 'PUT', {center_roles:[],branch_roles:{[north.id]:['registration'],[south.id]:['attendance']}})).status).toBe(200);
    await staff.goto(workspaceUrl(staff, `${host}/admin/students/${visible.body.student.id}/edit`));
    await staff.getByRole('textbox', {name:'المدرسة / جهة الدراسة',exact:true}).fill('تعديل مخول');
    await staff.getByRole('button', {name:'حفظ بيانات الطالب',exact:true}).click();
    await expectWorkspaceUrl(staff, `/admin/students/${visible.body.student.id}?focus=edit`);
    await expect(staff.getByText('تعديل مخول',{exact:true})).toBeVisible();
    await staff.getByRole('link', {name:'تعديل ملف الطالب',exact:true}).click();
    await staff.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`تعديل ممنوع ${stamp}`);
    const revokedWorkspace = new URL(staff.url()).searchParams.get('workspace')!;
    expect((await write(owner, `members/${member.id}/grants`, 'PUT', { center_roles:[], branch_roles:{} })).status).toBe(200);
    let deniedBody: { code: string } | undefined;
    let stalePatchRequests = 0;
    staff.on('request', request => {
      if (new URL(request.url()).pathname === `/api/v1/center/students/${visible.body.student.id}` && request.method() === 'PATCH') stalePatchRequests++;
    });
    const deniedRoute = '**/api/v1/center/students/similar?*';
    await staff.route(deniedRoute, async route => {
      const response = await route.fetch();
      deniedBody = await response.json();
      await route.fulfill({ response });
    }, { times: 1 });
    const deniedSave = staff.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/center/students/similar' && response.request().method() === 'GET');
    await staff.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
    const denied = await deniedSave;
    expect(denied.status()).toBe(409); expect(deniedBody?.code).toBe('workspace_expired');
    await staff.unroute(deniedRoute);
    await expect(staff).toHaveURL(/\/admin\/workspaces\?expired=1&return_to=/);
    await expect(staff.getByRole('heading', { name: 'اختيار مساحة العمل', exact: true })).toBeVisible();
    await expect(staff.getByRole('textbox', { name: 'اسم الطالب', exact: true })).toHaveCount(0);
    expect(stalePatchRequests).toBe(0);
    expect((await staff.request.get(`${host}/api/v1/center/students/${visible.body.student.id}`, { headers: { 'X-Courses-Workspace': revokedWorkspace } })).status()).toBe(409);
    const unchanged = await owner.request.get(`${host}/api/v1/center/students/${visible.body.student.id}`, { headers: { 'X-Courses-Workspace': new URL(owner.url()).searchParams.get('workspace')! } });
    expect(unchanged.status()).toBe(200);
    const unchangedStudent = (await unchanged.json()).students[0];
    expect(unchangedStudent.name).toBe(`مصرح ${stamp}`); expect(unchangedStudent.school).toBe('تعديل مخول');
    await signIn(beta, 'beta');
    expect((await beta.request.get(`${betaHost}/api/v1/center/students/${visible.body.student.id}`)).status()).toBe(404);
    const requestId = crypto.randomUUID();
    const payload = {name:`إعادة ${stamp}`,branch_ids:[north.id],request_id:requestId,school:'مشترك'};
    const creations = await Promise.all([write(owner, 'students', 'POST', payload), write(owner, 'students', 'POST', payload)]);
    expect(creations.map((item) => item.status).sort()).toEqual([200,201]);
    expect(creations[0].body.student.id).toBe(creations[1].body.student.id);
    const student = creations[0].body.student;
    const changes = await Promise.all(['أول', 'ثان'].map((school) => write(owner, `students/${student.id}`, 'PATCH', {name:student.name,branch_ids:student.branch_ids,revision:student.revision,school})));
    expect(changes.map((item) => item.status).sort()).toEqual([200,409]);
  } catch (error) { console.error('Original protected profile failure:', error); throw error; } finally {
    expect((await write(owner, `members/${member.id}/grants`, 'PUT', { center_roles:member.center_roles,branch_roles:member.branch_roles })).status).toBe(200);
    await owner.close(); await staff.close(); await beta.close();
  }
});

test('a shared contact warning permits a separate student without merging profiles', async ({ page }) => {
  await signIn(page);
  const name = `طالب قبول ${Date.now()}`;
  const phone = `010${String(Date.now()).slice(-8)}`;
  await page.goto(workspaceUrl(page, `${host}/admin/students/new`));
  await page.getByRole('textbox', { name:'اسم الطالب', exact:true }).fill(name);
  await fillRequiredCustomFields(page);
  await enterContact(page, phone);
  const firstResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/students') && response.request().method() === 'POST');
  await page.getByRole('button', {name:'حفظ ملف الطالب',exact:true}).click();
  const first = (await (await firstResponse).json()).student;
  createdStudentIds.add(first.id);
  await expectWorkspaceUrl(page, `/admin/students/${first.id}?focus=edit`);
  await page.goto(workspaceUrl(page, `${host}/admin/students/new`));
  await page.getByRole('textbox', {name:'اسم الطالب',exact:true}).fill(`طالب آخر ${Date.now()}`);
  await fillRequiredCustomFields(page);
  await enterContact(page, phone);
  await page.getByRole('button', {name:'حفظ ملف الطالب',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'توجد ملفات ببيانات متشابهة'})).toContainText(name);
  const secondResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/center/students') && response.request().method() === 'POST');
  await page.getByRole('button', {name:'إنشاء ملف مستقل',exact:true}).click();
  const second = (await (await secondResponse).json()).student;
  createdStudentIds.add(second.id);
  expect(second.student_number).not.toBe(first.student_number);
  await expectWorkspaceUrl(page, `/admin/students/${second.id}?focus=edit`);
});

test('normal SSR register, create, profile and edit each use at most six measured application SQL queries', async ({ page }) => {
  await signIn(page);
  const student = await create(page, `طالب قبول ${Date.now()}`);
  for (const route of ['/admin/students', '/admin/students/new', `/admin/students/${student.id}`, `/admin/students/${student.id}/edit`]) {
    const cursor = measureCursor();
    await page.goto(workspaceUrl(page, `${host}${route}`));
    await expect(page.getByRole('heading', { level:1 })).toBeVisible();
    const rows = measuredReads(cursor);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => typeof row.count === 'number' && row.count > 0)).toBe(true);
    expect(rows.reduce((sum,row) => sum+(row.count ?? Number.NaN),0)).toBeLessThanOrEqual(6);
    console.log(JSON.stringify({route,application_sql:rows.reduce((sum,row)=>sum+(row.count ?? Number.NaN),0),requests:rows.length}));
  }
  await page.goto(workspaceUrl(page, `${host}/admin/students?q=${encodeURIComponent(String(student.student_number))}`));
  const cursor = measureCursor();
  const link = await profileAction(page, student.name, student.id);
  await link.hover();
  await expect.poll(() => measuredReads(cursor).length).toBeGreaterThan(0);
  await link.click();
  await expectWorkspaceUrl(page, `${host}/admin/students/${student.id}`);
  await expect(page.getByRole('heading', {name:'ملف الطالب',exact:true})).toBeVisible();
  const rows = measuredReads(cursor);
  expect(rows.every((row) => typeof row.count === 'number' && row.count > 0)).toBe(true);
  expect(rows.reduce((sum,row) => sum+(row.count ?? Number.NaN),0)).toBeLessThanOrEqual(6);
  console.log(JSON.stringify({route:'warm table to profile navigation',application_sql:rows.reduce((sum,row)=>sum+(row.count ?? Number.NaN),0),requests:rows.length}));

});

async function enterContact(page: Page, phone: string) {
  await page.getByRole('button', {name:'إضافة جهة تواصل',exact:true}).click();
  await page.getByRole('textbox', {name:'اسم جهة التواصل 1',exact:true}).fill('صاحب الرقم المشترك');
  await page.getByRole('textbox', {name:'الصلة بالطالب 1',exact:true}).fill('ولي أمر');
  await page.getByRole('textbox', {name:'هاتف جهة التواصل 1',exact:true}).fill(phone);
  await expect(page.getByRole('textbox', {name:'اسم جهة التواصل 1',exact:true})).toHaveValue('صاحب الرقم المشترك');
  await expect(page.getByRole('textbox', {name:'الصلة بالطالب 1',exact:true})).toHaveValue('ولي أمر');
}

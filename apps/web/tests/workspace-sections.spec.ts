import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

test.skip(!process.env.COURSES_SECTIONS_CREDENTIALS, 'Requires isolated PostgreSQL/browser fixture.');
const origin = process.env.COURSES_SECTIONS_ORIGIN ?? 'http://alpha.courses.test:8057';
const credentials = process.env.COURSES_SECTIONS_CREDENTIALS ? JSON.parse(readFileSync(process.env.COURSES_SECTIONS_CREDENTIALS, 'utf8')) : {};
async function login(page: Page, who = 'alpha') {
  await page.goto(`${origin}/login`);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني', exact: true }).fill(credentials[who].email);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(credentials[who].password);
  await page.getByRole('button', { name: 'دخول المركز', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
async function write(page: Page, route: string, method: string, payload: object) {
  return page.evaluate(async ({route, method, payload}) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin' });
    const token = document.cookie.split('; ').find(part => part.startsWith('XSRF-TOKEN='))?.slice(11);
    const response = await fetch(`/api/v1/center/${route}`, {method, credentials: 'same-origin', headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '')}, body: JSON.stringify(payload)});
    return {status: response.status, body: await response.json()};
  }, {route, method, payload});
}
function cursor() { return readFileSync(process.env.COURSES_SECTIONS_READ_LOG!, 'utf8').length; }
function metrics(start: number) {
  return readFileSync(process.env.COURSES_SECTIONS_READ_LOG!, 'utf8').slice(start).trim().split('\n').filter(Boolean).map(row => JSON.parse(row));
}

test('peer views show one panel, retain route/header state, render without JS and fit RTL themes', async ({ page, browser }) => {
  test.setTimeout(90000); await login(page);
  mkdirSync('/tmp/courses-issue93', {recursive: true});
  const views = [
    ['/admin/students','سجل الطلاب'], ['/admin/students?tab=search','البحث عن طالب'],
    ['/admin/instructors','سجل المحاضرين'], ['/admin/instructors?tab=search','البحث عن محاضر'],
    ['/admin/student-search','البحث عن طالب'], ['/admin/student-search?tab=settings','إعدادات المشاركة والبحث'],
    ['/admin/curriculum','الكورسات'], ['/admin/curriculum?tab=stages','المراحل الدراسية'], ['/admin/curriculum?tab=levels','المستويات وخططها'],
  ];
  for (const [route, label] of views) {
    const start = cursor(); await page.goto(`${origin}${route}`);
    await expect(page.getByRole('tab', {name:label,exact:true})).toHaveAttribute('aria-selected','true');
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    const rows = metrics(start); expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => typeof row.count === 'number' && row.count > 0 && typeof row.ms === 'number')).toBe(true);
    const sql = rows.reduce((sum,row) => sum + row.count,0); expect(sql).toBeLessThanOrEqual(6);
    console.log(JSON.stringify({route,sql,sql_ms:rows.reduce((sum,row) => sum+row.ms,0)}));
    if (route.endsWith('tab=settings')) {
      await expect(page.getByRole('button', {name:'بحث في طلاب المركز',exact:true})).toHaveCount(0);
      await expect(page.getByRole('button', {name:'تغيير افتراضي المشاركة',exact:true})).toBeVisible();
    }
  }
  for (const [route, label] of [['students','سجل الطلاب'],['instructors','سجل المحاضرين']]) {
    await page.goto(`${origin}/admin/${route}?tab=search&q=missing-sections-result&page=99`);
    await page.getByRole('tab',{name:label,exact:true}).click();
    await expect(page).toHaveURL(`${origin}/admin/${route}?tab=register`);
    await expect(page.getByRole('table')).not.toContainText('لا يوجد');
    if (route === 'students') {
      const action = page.getByRole('button',{name:/^تغيير مشاركة الطالب — المشاركة (مسموحة|مغلقة)$/}).first();
      await expect(action).toBeVisible();
      await expect(action).toHaveAccessibleName(/المشاركة (مسموحة|مغلقة)$/);
    }
  }
  await page.goto(`${origin}/admin/curriculum?courses_page=1`);
  await page.locator('.center-topbar').evaluate(node => node.setAttribute('data-sections-header','retained'));
  const documents:string[]=[]; page.on('request',request => {if(request.resourceType()==='document')documents.push(request.url());});
  const courses = page.getByRole('tab',{name:'الكورسات',exact:true}); await courses.focus();
  await page.keyboard.press('ArrowLeft');
  const stages = page.getByRole('tab',{name:'المراحل الدراسية',exact:true}); await expect(stages).toBeFocused();
  await expect(courses).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Enter'); await expect(stages).toHaveAttribute('aria-selected','true');
  await expect(page).toHaveURL(/courses_page=1&tab=stages/); expect(documents).toHaveLength(0);
  await expect(page.locator('[data-sections-header="retained"]')).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab',{name:'المستويات وخططها',exact:true})).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('tab',{name:'المستويات وخططها',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page).toHaveURL(/tab=levels/);
  await expect(page.getByRole('table')).toHaveCount(1);
  await page.goBack(); await expect(page).toHaveURL(/tab=stages/); await expect(stages).toHaveAttribute('aria-selected','true');
  await page.reload(); await expect(stages).toHaveAttribute('aria-selected','true');
  const noJS = await browser.newContext({javaScriptEnabled:false,storageState:await page.context().storageState()});
  const ssr = await noJS.newPage(); await ssr.goto(`${origin}/admin/curriculum?tab=levels`);
  await expect(ssr.getByRole('table')).toHaveCount(1); await expect(ssr.getByRole('tab',{name:'المستويات وخططها',exact:true})).toHaveAttribute('aria-selected','true'); await noJS.close();
  for (const width of [1440,390]) for (const theme of ['light','dark']) {
    await page.setViewportSize({width,height:900}); await page.context().addCookies([{name:'courses_theme',value:theme,url:origin}]);
    for (const [route, label] of [['students','سجل الطلاب'],['instructors','سجل المحاضرين'],['student-search','البحث عن طالب'],['curriculum','الكورسات']]) {
      await page.goto(`${origin}/admin/${route}`); await expect(page.getByRole('tab',{name:label,exact:true})).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path:`/tmp/courses-issue93/${route}-${width}-${theme}.png`});
    }
  }
});

test('curriculum hierarchy stays in its active view with validation, dirty navigation and cancel focus', async ({page}) => {
  await login(page); await page.goto(`${origin}/admin/curriculum`);
  const name = `000 أقسام ${Date.now()}`;
  await page.getByRole('button',{name:'إنشاء كورس',exact:true}).click();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('button',{name:'حفظ المنهج',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'اسم الكورس',exact:true})).toBeFocused();
  await page.getByRole('textbox',{name:'اسم الكورس',exact:true}).fill(name);
  await page.getByRole('tab',{name:'المراحل الدراسية',exact:true}).click();
  await expect(page.getByRole('alertdialog',{name:'مغادرة دون حفظ'})).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button',{name:'إلغاء',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'اسم الكورس',exact:true})).toHaveValue(name);
  const courseResponse = page.waitForResponse(r => r.url().endsWith('/courses') && r.request().method()==='POST');
  await page.getByRole('button',{name:'حفظ المنهج',exact:true}).click(); expect((await courseResponse).status()).toBe(201);
  await expect(page.getByRole('tab',{name:'الكورسات',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('searchbox',{name:'بحث في الكورسات',exact:true}).fill(name);
  const addStage = page.getByRole('button',{name:'إضافة مرحلة دراسية',exact:true}); await addStage.click();
  await page.getByRole('textbox',{name:'اسم المرحلة الدراسية',exact:true}).fill(name);
  await page.getByRole('button',{name:'إلغاء',exact:true}).click(); await expect(addStage).toBeFocused();
  await addStage.click(); await page.getByRole('textbox',{name:'اسم المرحلة الدراسية',exact:true}).fill(name);
  await page.getByRole('button',{name:'حفظ المنهج',exact:true}).click();
  await expect(page.getByRole('tab',{name:'المراحل الدراسية',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('searchbox',{name:'بحث في المراحل الدراسية',exact:true}).fill(name);
  await page.getByRole('button',{name:'إضافة مستوى وخطته',exact:true}).click();
  await page.getByRole('textbox',{name:'اسم المستوى',exact:true}).fill(name);
  await page.getByRole('textbox',{name:'محتوى المحاضرة 1',exact:true}).fill('محتوى الأقسام');
  await page.getByRole('button',{name:'حفظ المنهج',exact:true}).click();
  await expect(page.getByRole('tab',{name:'المستويات وخططها',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('table')).toHaveCount(1);
  await page.getByRole('searchbox',{name:'بحث في المستويات وخططها',exact:true}).fill(name);
  await expect(page.getByRole('link',{name,exact:true})).toBeVisible();
});

test('instructor editor owns the header form and survives errors while tabs protect drafts', async ({page}) => {
  await login(page); await page.goto(`${origin}/admin/instructors`);
  const name = `000 محاضر أقسام ${Date.now()}`;
  await page.getByRole('button',{name:'إنشاء ملف محاضر',exact:true}).click();
  const input = page.getByRole('textbox',{name:'اسم المحاضر',exact:true}); await input.fill(name);
  const submit = page.getByRole('button',{name:'حفظ ملف المحاضر',exact:true});
  const id = await submit.getAttribute('form'); expect(id).toBeTruthy(); await expect(page.locator(`form[id="${id}"]`)).toHaveCount(1);
  await page.getByRole('tab',{name:'البحث عن محاضر',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'إلغاء',exact:true}).click(); await expect(input).toHaveValue(name);
  await submit.click(); await expect(page.getByRole('status').filter({hasText:'أُنشئ ملف المحاضر'})).toBeVisible();
  await page.getByRole('searchbox',{name:'بحث في سجل المحاضرين',exact:true}).fill(name);
  const edit = page.getByRole('button',{name:'تعديل ملف المحاضر',exact:true}); await edit.click();
  const instructors = (await (await page.request.get(`${origin}/api/v1/center/instructor-workspace?q=${encodeURIComponent(name)}`)).json()).instructors;
  expect((await write(page,`instructors/${instructors[0].id}`,'PATCH',{name:`${name} آخر`,phone:null,branch_ids:[],revision:instructors[0].revision})).status).toBe(200);
  await input.fill(`${name} مسودة`); await page.getByRole('button',{name:'حفظ بيانات المحاضر',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'تغيّرت بيانات الملف'})).toBeVisible(); await expect(input).toHaveValue(`${name} مسودة`);
  await page.getByRole('button',{name:'تحميل أحدث بيانات المحاضر',exact:true}).click(); await expect(input).toHaveValue(`${name} آخر`);
  await page.getByRole('button',{name:'إلغاء',exact:true}).click(); await expect(page.locator(`[data-instructor-edit="${instructors[0].id}"]`)).toBeFocused();
  await expect(page.getByRole('searchbox',{name:'بحث في سجل المحاضرين',exact:true})).toHaveValue(name);
  await page.getByRole('tab',{name:'البحث عن محاضر',exact:true}).click();
  await page.getByRole('textbox',{name:'البحث في جميع الملفات المصرح بها',exact:true}).fill(name);
  await page.getByRole('button',{name:'بحث عن محاضر',exact:true}).click(); await expect(page).toHaveURL(/tab=search&q=/);
  await expect(page.getByRole('table')).toContainText(`${name} آخر`);
});

test('search settings register only their actions and recover current policy before returning to search', async ({page,browser}) => {
  await login(page); await page.goto(`${origin}/admin/student-search`);
  const original = (await (await page.request.get(`${origin}/api/v1/center/student-search-workspace`)).json()).policy;
  try {
    await expect(page.getByRole('button',{name:'تغيير افتراضي المشاركة',exact:true})).toHaveCount(0);
    await page.getByRole('tab',{name:'إعدادات المشاركة والبحث',exact:true}).click();
    await expect(page.getByRole('form',{name:'البحث في البيانات الأساسية لطلاب المركز'})).toHaveCount(0);
    await page.getByRole('button',{name:'تغيير افتراضي المشاركة',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:original.default_sharing_enabled ? 'غلق المشاركة للملفات الجديدة' : 'السماح بالمشاركة للملفات الجديدة',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'حُفظ افتراضي'})).toBeVisible();
    const current = (await (await page.request.get(`${origin}/api/v1/center/student-search-workspace`)).json()).policy;
    expect((await write(page,'student-search-policy','PATCH',{enabled:!current.enabled,revision:current.revision})).status).toBe(200);
    await page.getByRole('button',{name:'تغيير افتراضي المشاركة',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:current.default_sharing_enabled ? 'غلق المشاركة للملفات الجديدة' : 'السماح بالمشاركة للملفات الجديدة',exact:true}).click();
    await expect(page.getByRole('alert').filter({hasText:'تغيّر إعداد البحث'})).toBeVisible();
    await expect(page.getByRole('button',{name:'تحميل أحدث إعداد',exact:true})).toHaveCount(1);
    await page.getByRole('button',{name:'تحميل أحدث إعداد',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'حُمّل أحدث إعداد'})).toBeVisible();
    const enabled = (await (await page.request.get(`${origin}/api/v1/center/student-search-workspace`)).json()).policy.enabled;
    if (!enabled) {
      await page.getByRole('button',{name:'تفعيل البحث بين الفروع',exact:true}).click();
      await page.getByRole('alertdialog').getByRole('button',{name:'تفعيل البحث',exact:true}).click();
      await expect(page.getByRole('status').filter({hasText:'فُعّل البحث'})).toBeVisible();
    }
    await page.getByRole('tab',{name:'البحث عن طالب',exact:true}).click();
    await expect(page.getByRole('button',{name:'تغيير افتراضي المشاركة',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'بحث في طلاب المركز',exact:true})).toBeVisible();
    const student = (await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json()).students[0];
    const search = page.getByRole('textbox',{name:'الاسم أو رقم الطالب الداخلي أو رقم التواصل',exact:true});
    await search.fill(String(student.student_number));
    await page.getByRole('button',{name:'بحث في طلاب المركز',exact:true}).click();
    await expect(page.getByRole('table')).toContainText(student.name);
    await page.getByRole('button',{name:'مسح البحث',exact:true}).click(); await expect(search).toBeFocused(); await expect(search).toHaveValue('');
    const staff = await browser.newPage(); await login(staff,'staff'); await staff.goto(`${origin}/admin/student-search?tab=settings`);
    await expect(staff.getByRole('tab',{name:'إعدادات المشاركة والبحث',exact:true})).toHaveCount(0); await staff.close();
  } finally {
    const current = (await (await page.request.get(`${origin}/api/v1/center/student-search-workspace`)).json()).policy;
    expect((await write(page,'student-search-policy','PATCH',{enabled:original.enabled,default_sharing_enabled:original.default_sharing_enabled,revision:current.revision})).status).toBe(200);
  }
});

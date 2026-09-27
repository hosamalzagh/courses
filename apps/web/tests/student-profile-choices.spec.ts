import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.skip(!process.env.COURSES_CHOICES_CREDENTIALS, 'Requires the disposable student-choice PostgreSQL fixture.');
const origin = process.env.COURSES_CHOICES_ORIGIN ?? 'http://alpha.courses.test:8057';
const credentials = process.env.COURSES_CHOICES_CREDENTIALS ? JSON.parse(readFileSync(process.env.COURSES_CHOICES_CREDENTIALS, 'utf8')) : {};
async function signIn(page: Page, who = 'alpha') {
  await page.goto(`${who === 'beta' ? origin.replace('alpha.', 'beta.') : origin}/login`);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).pressSequentially(credentials[who].email);
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).pressSequentially(credentials[who].password);
  await page.getByRole('button', { name: 'دخول المركز', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
test('manage all five lists, select on create, disable and preserve old profile values', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'قوائم بيانات الطالب', exact: true }).click();
  const labels = ['المدينة', 'المؤهل الدراسي', 'المهنة', 'طريقة جمع البيانات', 'مصدر معرفة الطالب بالمركز'];
  const stamp = Date.now();
  for (const [index, label] of labels.entries()) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await page.getByRole('button', { name: 'إضافة اختيار', exact: true }).click();
    await page.getByRole('textbox', { name: 'اسم الاختيار', exact: true }).fill(`اختيار ${index} ${stamp}`);
    await page.getByRole('textbox', { name: 'الترتيب', exact: true }).fill(String(index));
    await page.getByRole('button', { name: 'حفظ الاختيار', exact: true }).click();
    await expect(page.getByRole('cell', { name: `اختيار ${index} ${stamp}`, exact: true })).toBeVisible();
  }
  await page.getByRole('link', { name: 'الطلاب', exact: true }).first().click();
  await page.getByRole('link', { name: 'إنشاء ملف طالب', exact: true }).click();
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(`طالب قوائم ${stamp}`);
  for (const [index, label] of labels.entries()) await select(page, label, `اختيار ${index} ${stamp}`);
  await page.getByRole('textbox', { name: 'المدرسة / جهة الدراسة', exact: true }).fill('جهة دراسة حرة');
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/students'));
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  const student = (await (await response).json()).student;
  await expect(page).toHaveURL(new RegExp(`/students/${student.id}`));
  for (let i = 0; i < 5; i++) await expect(page.getByText(`اختيار ${i} ${stamp}`, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'قوائم بيانات الطالب', exact: true }).click();
  await page.getByRole('link', { name: 'المدينة', exact: true }).click();
  await page.getByRole('row').filter({ hasText: `اختيار 0 ${stamp}` }).getByRole('button', { name: 'تعديل', exact: true }).click();
  await page.getByRole('checkbox', { name: 'متاح للاستخدام الجديد', exact: true }).uncheck();
  await page.getByRole('button', { name: 'حفظ الاختيار', exact: true }).click();
  await page.goto(`${origin}/admin/students/${student.id}/edit`);
  await expect(page.getByRole('combobox', { name: 'المدينة', exact: true })).toContainText(`اختيار 0 ${stamp}`);
  await page.getByRole('textbox', { name: 'جهة العمل', exact: true }).fill('تعديل مع اختيار معطل');
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expect(page.getByText(`اختيار 0 ${stamp} — معطل`, { exact: true })).toBeVisible();
  await page.goto(`${origin}/admin/students/new`);
  await page.getByRole('combobox', { name: 'المدينة', exact: true }).click();
  await expect(page.getByRole('option', { name: `اختيار 0 ${stamp}`, exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

async function write(page: Page, route: string, method: string, payload: object) {
  return page.evaluate(async ({route, method, payload}) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin' });
    const token = document.cookie.split('; ').find(part => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, {route, method, payload});
}

test('real HTTP retries, concurrent revisions, center isolation and next-request revocation', async ({ browser }) => {
  const owner = await browser.newPage(); const staff = await browser.newPage(); const beta = await browser.newPage();
  await signIn(owner); await signIn(staff, 'staff'); await signIn(beta, 'beta');
  const uuid = () => crypto.randomUUID();
  const payload = { id: uuid(), kind: 'profession', label: `متزامن ${Date.now()}`, position: 1, active: true };
  const results = await Promise.all([write(owner, 'student-profile-choices', 'POST', payload), write(owner, 'student-profile-choices', 'POST', payload)]);
  expect(results.map(row => row.status).sort()).toEqual([200,201]);
  expect(results[0].body.choice.id).toBe(results[1].body.choice.id);
  const route = `student-profile-choices/${payload.id}`;
  const changes = await Promise.all(['أول', 'ثان'].map(label => write(owner, route, 'PATCH', { label, active: true, position: 2, revision: 1 })));
  expect(changes.map(row => row.status).sort()).toEqual([200,409]);
  expect((await write(staff, route, 'PATCH', { label:'تجاوز',active:false,position:1,revision:2 })).status).toBe(403);
  await staff.goto(`${origin}/admin/students/new`);
  await expect(staff.getByRole('combobox', { name:'المهنة',exact:true })).toBeVisible();
  await expect(staff.getByRole('link', { name:'قوائم بيانات الطالب',exact:true })).toHaveCount(0);
  expect((await beta.request.get(`${origin.replace('alpha.','beta.')}/api/v1/center/${route}`)).status()).toBe(404);
  const branches = (await (await beta.request.get(`${origin.replace('alpha.','beta.')}/api/v1/center/student-workspace`)).json()).branches;
  expect((await write(beta,'students','POST',{ name:'اختيار مركز آخر',branch_ids:[branches[0].id],request_id:uuid(),profession_id:payload.id })).status).toBe(422);
  const members = (await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json()).members;
  const member = members.find((member: {user:{email:string}}) => member.user.email === credentials.staff.email);
  try {
    expect((await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:['center_admin'],branch_roles:member.branch_roles})).status).toBe(200);
    await staff.goto(`${origin}/admin/student-profile-choices?kind=profession`);
    await staff.getByRole('row').filter({hasText: changes.find(row => row.status === 200)!.body.choice.label}).getByRole('button',{name:'تعديل',exact:true}).first().click();
    await staff.getByRole('textbox',{name:'اسم الاختيار',exact:true}).fill('بعد سحب الصلاحية');
    expect((await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:[],branch_roles:member.branch_roles})).status).toBe(200);
    await staff.getByRole('button',{name:'حفظ الاختيار',exact:true}).click();
    await expect(staff.getByRole('alert').filter({hasText:'خارج صلاحيتك'})).toBeVisible();
  } finally {
    await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:member.center_roles,branch_roles:member.branch_roles});
    await owner.close(); await staff.close(); await beta.close();
  }
});

test('large lists load progressively without losing values and stale definitions recover in the header', async ({page}) => {
  test.setTimeout(60_000);
  await signIn(page);
  const stamp = Date.now();
  let last = '';
  for (let i=0;i<51;i++) {
    const result = await write(page,'student-profile-choices','POST',{id:crypto.randomUUID(),kind:'city',label:`دفعة ${stamp} ${i}`,position:1000+i,active:true});
    expect(result.status).toBe(201); last = result.body.choice.id;
  }
  await page.goto(`${origin}/admin/students/new`);
  await page.getByRole('textbox',{name:'اسم الطالب',exact:true}).fill(`طالب طويل ${stamp}`);
  await page.getByRole('combobox',{name:'المهنة',exact:true}).click(); await page.getByRole('option').filter({hasText:/^(أول|ثان)$/}).first().click();
  while (await page.getByRole('button',{name:'تحميل المزيد من المدينة',exact:true}).count()) {
    const response = page.waitForResponse(r=>r.url().includes('student-profile-choices?kind=city'));
    await page.getByRole('button',{name:'تحميل المزيد من المدينة',exact:true}).click(); expect((await response).status()).toBe(200);
    await expect(page.locator('button[aria-busy=true]')).toHaveCount(0);
  }
  await select(page,'المدينة',`دفعة ${stamp} 50`);
  await expect(page.getByRole('textbox',{name:'اسم الطالب',exact:true})).toHaveValue(`طالب طويل ${stamp}`);
  const saved = page.waitForResponse(r=>r.url().endsWith('/students')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'حفظ ملف الطالب',exact:true}).click();
  const student = (await (await saved).json()).student; expect(student.city_id).toBe(last);
  await expect(page).toHaveURL(new RegExp(`/students/${student.id}`));
  await page.getByRole('link',{name:'تعديل ملف الطالب',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'المدينة',exact:true})).toContainText(`دفعة ${stamp} 50`);
  await page.goto(`${origin}/admin/student-profile-choices?kind=city&q=${encodeURIComponent(`دفعة ${stamp} 50`)}`);
  await page.getByRole('button',{name:'تعديل',exact:true}).click();
  expect((await write(page,`student-profile-choices/${last}`,'PATCH',{label:`زميل ${stamp}`,active:true,position:500,revision:1})).status).toBe(200);
  await page.getByRole('textbox',{name:'اسم الاختيار',exact:true}).fill('نسخة قديمة');
  await page.getByRole('button',{name:'حفظ الاختيار',exact:true}).click();
  await expect(page.getByRole('button',{name:'تحميل الاختيار الحالي',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'تحميل الاختيار الحالي',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'اسم الاختيار',exact:true})).toHaveValue(`زميل ${stamp}`);
  await expect(page.getByRole('textbox',{name:'اسم الاختيار',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'إلغاء',exact:true}).click();
  await expect(page.getByRole('button',{name:'تعديل',exact:true})).toBeFocused();
});

test('full SSR reads and warm navigation preserve six-query budget and shell on desktop and mobile', async ({page}) => {
  await signIn(page);
  const log = process.env.COURSES_CHOICES_READ_LOG!;
  const cursor = () => readFileSync(log,'utf8').trim().split('\n').length;
  const rows = (offset:number) => readFileSync(log,'utf8').trim().split('\n').slice(offset).map(row=>JSON.parse(row)).filter(row=>row.path.startsWith('/api/v1/center/'));
  for (const route of ['/admin/student-profile-choices','/admin/students/new','/admin/students']) {
    const start=cursor(); await page.goto(`${origin}${route}`); await expect(page.getByRole('heading',{level:1})).toBeVisible();
    const reads=rows(start); expect(reads.length).toBeGreaterThan(0); expect(reads.every(row=>typeof row.count==='number'&&row.count>0)).toBe(true);
    const total=reads.reduce((sum,row)=>sum+row.count,0); expect(total).toBeLessThanOrEqual(6);console.log(JSON.stringify({route,total,requests:reads.length}));
  }
  const start=cursor();
  await page.locator('.center-topbar').evaluate(element=>element.setAttribute('data-persist-proof','yes'));
  const documents: string[]=[];page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
  const link=page.getByRole('link',{name:'قوائم بيانات الطالب',exact:true});await link.hover();await expect.poll(()=>rows(start).length).toBeGreaterThan(0);await link.click();
  await expect(page.getByRole('heading',{name:'قوائم بيانات الطالب',exact:true})).toBeVisible();
  await expect(page.locator('.center-topbar')).toHaveAttribute('data-persist-proof','yes'); expect(documents).toEqual([]);
  expect(rows(start).reduce((sum,row)=>sum+row.count,0)).toBeLessThanOrEqual(6);
  await page.getByRole('button',{name:'إضافة اختيار',exact:true}).click();await page.getByRole('button',{name:'حفظ الاختيار',exact:true}).click();await expect(page.getByRole('textbox',{name:'اسم الاختيار',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'إلغاء',exact:true}).click();
  await page.screenshot({path:'/tmp/courses-issue57/lists-desktop-light.png',fullPage:true});
  await page.getByRole('button',{name:'تفعيل الوضع الداكن'}).click(); await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.screenshot({path:'/tmp/courses-issue57/lists-desktop-dark.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'إضافة اختيار',exact:true}).click();await expect(page.getByRole('textbox',{name:'اسم الاختيار',exact:true})).toBeFocused();
  await page.screenshot({path:'/tmp/courses-issue57/lists-mobile-dark.png',fullPage:true});
  await page.getByRole('button',{name:'إلغاء',exact:true}).click();
});

test('a committed choice with a lost response retries the same definition and audit stays readable', async ({page}) => {
  await signIn(page); await page.goto(`${origin}/admin/student-profile-choices?kind=qualification`);
  await page.getByRole('button',{name:'إضافة اختيار',exact:true}).click();
  const label=`استعادة اختيار ${Date.now()}`;
  await page.getByRole('textbox',{name:'اسم الاختيار',exact:true}).fill(label);
  let id='';
  await page.route('**/api/v1/center/student-profile-choices',async route=>{
    const response=await route.fetch(); expect(response.status()).toBe(201);id=(await response.json()).choice.id;await route.abort('connectionclosed');
  },{times:1});
  await page.getByRole('button',{name:'حفظ الاختيار',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'تعذر حفظ الاختيار'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'اسم الاختيار',exact:true})).toHaveValue(label);
  const retry=page.waitForResponse(r=>r.url().endsWith('/student-profile-choices')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'حفظ الاختيار',exact:true}).click();const response=await retry;expect(response.status()).toBe(200);expect((await response.json()).choice.id).toBe(id);
  const definitions=(await (await page.request.get(`${origin}/api/v1/center/student-profile-choices?kind=qualification&manage=1&q=${encodeURIComponent(label)}`)).json()).choices;expect(definitions).toHaveLength(1);
  await page.getByRole('link',{name:'سجل التدقيق',exact:true}).click();await page.getByText('عرض تغيير قائمة الطالب',{exact:true}).first().click();await expect(page.getByText(`بعد التغيير: ${label}`,{exact:false})).toBeVisible();
});

test('clearing choice search restores all results without losing form inputs', async ({page}) => {
  await signIn(page); await page.goto(`${origin}/admin/students/new`);
  await page.getByRole('textbox',{name:'اسم الطالب',exact:true}).fill('مدخل محفوظ أثناء البحث');
  const search=page.getByRole('textbox',{name:'البحث في المدينة',exact:true});
  await search.fill(`لا توجد مدينة ${Date.now()}`);
  const response=page.waitForResponse(r=>r.url().includes('student-profile-choices?kind=city'));
  await page.getByRole('button',{name:'بحث في المدينة',exact:true}).click();expect((await response).status()).toBe(200);
  await expect(page.locator('button[aria-busy=true]')).toHaveCount(0);
  await search.fill('');await expect(search).toBeVisible();
  await page.getByRole('button',{name:'بحث في المدينة',exact:true}).click();
  await expect(page.getByRole('button',{name:'تحميل المزيد من المدينة',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'اسم الطالب',exact:true})).toHaveValue('مدخل محفوظ أثناء البحث');
});

test('moving a definition across the server page boundary replaces its old row', async ({page}) => {
  await signIn(page);await page.goto(`${origin}/admin/student-profile-choices?kind=city`);
  const rows=(await (await page.request.get(`${origin}/api/v1/center/student-profile-choices?kind=city&manage=1`)).json()).choices;
  expect(rows).toHaveLength(50);
  const next=(await (await page.request.get(`${origin}/api/v1/center/student-profile-choices?kind=city&manage=1&page=2`)).json()).choices;
  const replacement=next[0];
  const choice=rows[0];
  await page.getByRole('row').filter({has:page.getByRole('cell',{name:choice.label,exact:true})}).getByRole('button',{name:'تعديل',exact:true}).click();
  await page.getByRole('textbox',{name:'الترتيب',exact:true}).fill('999999');
  await page.getByRole('button',{name:'حفظ الاختيار',exact:true}).click();
  await expect(page.getByRole('cell',{name:choice.label,exact:true})).toHaveCount(0);
  await page.getByPlaceholder('بحث في المدينة…').fill(replacement.label);
  await expect(page.getByRole('cell',{name:replacement.label,exact:true})).toBeVisible();
});

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.skip(!process.env.COURSES_CONTACTS_CREDENTIALS, 'Requires the disposable student-contact PostgreSQL fixture.');
const origin = process.env.COURSES_CONTACTS_ORIGIN ?? 'http://alpha.courses.test:8057';
const credentials = process.env.COURSES_CONTACTS_CREDENTIALS ? JSON.parse(readFileSync(process.env.COURSES_CONTACTS_CREDENTIALS, 'utf8')) : {};
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
test('create an adult profile with owned shared channels and preserve them across edits', async ({ page }) => {
  const phone = `000${Date.now()}`; const name = `بالغ تواصل ${Date.now()}`;
  await signIn(page);
  await page.goto(`${origin}/admin/students/new`);
  await page.getByRole('textbox', { name: 'اسم الطالب', exact: true }).fill(name);
  await page.getByRole('button', { name: 'إضافة جهة تواصل', exact: true }).click();
  await page.getByRole('textbox', { name: 'اسم جهة التواصل 1', exact: true }).fill('صاحب الرقم');
  await page.getByRole('textbox', { name: 'الصلة بالطالب 1', exact: true }).fill('الطالب نفسه');
  await page.getByRole('textbox', { name: 'هاتف جهة التواصل 1', exact: true }).fill(phone);
  await select(page, 'صاحب قناة واتساب', 'صاحب الرقم — الطالب نفسه');
  await page.getByRole('textbox', { name: 'رقم قناة واتساب', exact: true }).fill(phone);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/students'));
  await page.getByRole('button', { name: 'حفظ ملف الطالب', exact: true }).click();
  const student = (await (await response).json()).student;
  await expect(page).toHaveURL(new RegExp(`/students/${student.id}\\?focus=edit$`));
  await expect(page.getByText('صاحب الرقم — الطالب نفسه — أساسية', { exact: true })).toBeVisible();
  await expect(page.getByText('واتساب: صاحب الرقم', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'تعديل ملف الطالب', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'هاتف جهة التواصل 1', exact: true })).toHaveValue(phone);
  await page.getByRole('textbox', { name: 'جهة العمل', exact: true }).fill('تعديل يحفظ القنوات');
  await page.getByRole('button', { name: 'حفظ بيانات الطالب', exact: true }).click();
  await expect(page.getByText('واتساب: صاحب الرقم', { exact: true })).toBeVisible();
  await page.getByRole('link',{name:'سجل التغييرات',exact:true}).click();
  const entry = page.getByRole('row').filter({hasText:name}).first();
  await entry.locator('summary').click();
  await expect(entry).toContainText('صاحب الرقم'); await expect(entry).toContainText(phone);
});

async function write(page: Page, route: string, method: string, payload: object) {
  return page.evaluate(async ({route, method, payload}) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin' });
    const token = document.cookie.split('; ').find(part => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, {route, method, payload});
}


test('real concurrent contact writes, legacy completion, foreign center and revoked branch grants', async ({browser}) => {
  const owner = await browser.newPage(); const staff = await browser.newPage(); const beta = await browser.newPage();
  await signIn(owner); await signIn(staff, 'staff'); await signIn(beta, 'beta');
  const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const north = workspace.branches.find((branch: {slug:string}) => branch.slug === 'north');
  const south = workspace.branches.find((branch: {slug:string}) => branch.slug === 'south');
  const members = (await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json()).members;
  const member = members.find((member: {user:{email:string}}) => member.user.email === credentials.staff.email);
  const phone = `000${Date.now()}`;
  const payload = {name:`تواصل قديم ${Date.now()}`,phone,branch_ids:[north.id],request_id:crypto.randomUUID()};
  const creations = await Promise.all([write(owner,'students','POST',payload),write(owner,'students','POST',payload)]);
  expect(creations.map(row => row.status).sort()).toEqual([200,201]);
  const student = creations[0].body.student;
  expect(creations[1].body.student.id).toBe(student.id);
  const contact = {id:crypto.randomUUID(),name:'صاحب معروف',relationship:'الطالب نفسه',phone,primary:true};
  const edit = {name:student.name,phone,branch_ids:[],revision:1,contacts:[contact],channels:{whatsapp:{contact_id:contact.id,phone}}};
  const edits = await Promise.all(['أول','ثان'].map(name => write(owner,`students/${student.id}`,'PATCH',{...edit,contacts:[{...contact,name}]})));
  expect(edits.map(row => row.status).sort()).toEqual([200,409]);
  expect(edits.find(row => row.status === 200)!.body.student.legacy_phone).toBe(phone);
  await owner.goto(`${origin}/admin/students/${student.id}`);
  await expect(owner.getByText('رقم سابق — صاحبه غير محدد:',{exact:false})).toContainText(phone);
  expect((await beta.request.get(`${origin.replace('alpha.','beta.')}/api/v1/center/students/${student.id}`)).status()).toBe(404);
  try {
    expect((await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:[],branch_roles:{[north.id]:['registration'],[south.id]:['attendance']}})).status).toBe(200);
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    await staff.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true}).fill('بعد سحب التسجيل');
    expect((await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:[],branch_roles:{[north.id]:['attendance']}})).status).toBe(200);
    await staff.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click();
    await expect(staff.getByRole('alert')).toBeVisible();
    await expect(staff.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true})).toHaveValue('بعد سحب التسجيل');
    const current = await (await owner.request.get(`${origin}/api/v1/center/students/${student.id}`)).json();
    expect(current.students[0].contacts[0].name).not.toBe('بعد سحب التسجيل');
    expect(current.students[0].legacy_phone).toBe(phone);
  } finally {
    await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:member.center_roles,branch_roles:member.branch_roles});
    await owner.close(); await staff.close(); await beta.close();
  }
});

test('stale contact form retains input and recovers current values through the shared header', async ({page}) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const contact = {id:crypto.randomUUID(),name:'صاحب البداية',relationship:'قريب',phone:`000${Date.now()}`,primary:true};
  const result = await write(page,'students','POST',{name:`تعارض تواصل ${Date.now()}`,branch_ids:[workspace.branches[0].id],request_id:crypto.randomUUID(),contacts:[contact],channels:{}});
  expect(result.status).toBe(201);
  const student = result.body.student;
  await page.goto(`${origin}/admin/students/${student.id}/edit`);
  await page.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true}).fill('مسودة محفوظة');
  expect((await write(page,`students/${student.id}`,'PATCH',{name:student.name,branch_ids:[],revision:1,contacts:[{...contact,name:'أحدث جهة'}],channels:{}})).status).toBe(200);
  await page.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'تغيّرت بيانات الملف'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true})).toHaveValue('مسودة محفوظة');
  await expect(page.getByRole('button',{name:'حفظ بيانات الطالب',exact:true})).toBeDisabled();
  const recovery = page.getByRole('button',{name:'تحميل أحدث بيانات الطالب',exact:true});
  expect(await recovery.evaluate(button => Boolean(button.closest('header')))).toBe(true);
  await recovery.click();
  await expect(page.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true})).toHaveValue('أحدث جهة');
  await page.getByRole('textbox',{name:'الصلة بالطالب 1',exact:true}).fill('صلة بعد الاسترداد');
  await page.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click();
  await expect(page.getByText('أحدث جهة — صلة بعد الاسترداد — أساسية',{exact:true})).toBeVisible();
});

test('contact validation, cancel focus and RTL themes stay usable on desktop and mobile', async ({page}) => {
  await signIn(page); await page.goto(`${origin}/admin/students/new`);
  await page.getByRole('textbox',{name:'اسم الطالب',exact:true}).fill('تحقق واجهة التواصل');
  const add = page.getByRole('button',{name:'إضافة جهة تواصل',exact:true});
  expect(await add.evaluate(button => Boolean(button.closest('header')))).toBe(true);
  await add.click();
  const name = page.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true});
  await expect(name).toBeFocused();
  await page.getByRole('button',{name:'حفظ ملف الطالب',exact:true}).click();
  await expect(name).toBeFocused();
  await name.fill('جهة لوحة المفاتيح');
  await page.getByRole('textbox',{name:'الصلة بالطالب 1',exact:true}).fill('الطالب نفسه');
  const phone = page.getByRole('textbox',{name:'هاتف جهة التواصل 1',exact:true});
  await phone.fill('abc');
  await page.getByRole('button',{name:'حفظ ملف الطالب',exact:true}).click();
  await expect(phone).toHaveAttribute('aria-invalid','true'); await expect(phone).toBeFocused();
  await phone.fill('000555');
  await page.getByRole('combobox',{name:'صاحب قناة واتساب',exact:true}).focus();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox',{name:'رقم قناة واتساب',exact:true})).toHaveValue('000555');
  await page.screenshot({path:'/tmp/courses-issue57/contacts-desktop-light.png',fullPage:true});
  await page.getByRole('button',{name:'تفعيل الوضع الداكن'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.screenshot({path:'/tmp/courses-issue57/contacts-desktop-dark.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/courses-issue57/contacts-mobile-dark.png',fullPage:true});
  const cancel = page.getByRole('link',{name:'إلغاء',exact:true});
  await cancel.click(); await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button',{name:'إلغاء',exact:true}).click();
  await expect(cancel).toBeFocused(); await expect(phone).toHaveValue('000555');
  await page.getByRole('button',{name:'حذف جهة التواصل 1',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'رقم قناة واتساب',exact:true})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true})).toHaveCount(0);
});

test('measured SSR contact pages and warm navigation retain the shell within six SQL queries', async ({page}) => {
  test.skip(!process.env.COURSES_CONTACTS_READ_LOG,'Requires the SSR proxy read log.');
  const log = process.env.COURSES_CONTACTS_READ_LOG!;
  const cursor = () => readFileSync(log,'utf8').split('\n').filter(Boolean).length;
  const reads = (start:number) => readFileSync(log,'utf8').split('\n').filter(Boolean).slice(start).map(line => JSON.parse(line)).filter(row => row.host?.startsWith('alpha.') && row.path?.startsWith('/api/v1/center/')) as {count:number|null;path:string}[];
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const contact = {id:crypto.randomUUID(),name:'ملخص محسوب',relationship:'قريب',phone:`000${Date.now()}`,primary:true};
  const result = await write(page,'students','POST',{name:`قياس تواصل ${Date.now()}`,branch_ids:[workspace.branches[0].id],request_id:crypto.randomUUID(),contacts:[contact],channels:{}});
  expect(result.status).toBe(201); const student = result.body.student;
  for (const route of ['/admin/students','/admin/students/new',`/admin/students/${student.id}`,`/admin/students/${student.id}/edit`]) {
    const start = cursor(); await page.goto(`${origin}${route}`); await expect(page.getByRole('heading',{level:1})).toBeVisible();
    const rows = reads(start); expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => typeof row.count === 'number' && row.count > 0)).toBe(true);
    const sql = rows.reduce((sum,row) => sum+(row.count ?? Number.NaN),0); expect(sql).toBeLessThanOrEqual(6);
    console.log(JSON.stringify({route,sql}));
  }
  await page.goto(`${origin}/admin/students?q=${student.student_number}`);
  await page.locator('.center-topbar').evaluate(element => element.setAttribute('data-contact-shell','retained'));
  const documents:string[]=[]; page.on('request',request => {if(request.resourceType()==='document') documents.push(request.url());});
  const start = cursor(); const link = page.locator(`a[href="/admin/students/${student.id}"]`).first();
  await link.hover(); await expect.poll(() => reads(start).length).toBeGreaterThan(0); await link.click();
  await expect(page.getByText('ملخص محسوب — قريب — أساسية',{exact:true})).toBeVisible();
  await expect(page.locator('.center-topbar')).toHaveAttribute('data-contact-shell','retained'); expect(documents).toEqual([]);
  const rows = reads(start); expect(rows.every(row => typeof row.count === 'number' && row.count > 0)).toBe(true);
  expect(rows.reduce((sum,row) => sum+(row.count ?? Number.NaN),0)).toBeLessThanOrEqual(6);
});

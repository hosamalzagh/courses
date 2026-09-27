import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.skip(!process.env.COURSES_CODES_CREDENTIALS, 'Requires the disposable student-code PostgreSQL fixture.');
const origin = process.env.COURSES_CODES_ORIGIN ?? 'http://alpha.courses.test:8057';
const credentials = process.env.COURSES_CODES_CREDENTIALS ? JSON.parse(readFileSync(process.env.COURSES_CODES_CREDENTIALS, 'utf8')) : {};
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
test('enable a named card, preserve leading zeros, and scan one authorized profile', async ({page}) => {
  await signIn(page); await page.goto(`${origin}/admin/settings`);
  await page.getByRole('checkbox',{name:'تفعيل الباركود الإضافي',exact:true}).check();
  await page.getByRole('textbox',{name:'اسم الباركود الإضافي',exact:true}).fill('كارت المركز');
  await page.getByRole('button',{name:'حفظ إعداد الباركود الإضافي',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'حُفظ إعداد الباركود الإضافي'})).toBeVisible();
  const cityLabel=`000 كارت ${Date.now()}`; const cityId=crypto.randomUUID();
  expect((await write(page,'student-profile-choices','POST',{id:cityId,kind:'city',label:cityLabel,position:0,active:true})).status).toBe(201);
  await page.goto(`${origin}/admin/students/new`);
  if (await page.getByRole('textbox',{name:'البحث في المدينة',exact:true}).count()) {
    await page.getByRole('textbox',{name:'البحث في المدينة',exact:true}).fill(cityLabel); await page.getByRole('button',{name:'بحث في المدينة',exact:true}).click();
    await expect(page.locator('button[aria-busy="true"]')).toHaveCount(0);
  }
  await select(page,'المدينة',cityLabel);
  await page.getByRole('button',{name:'إضافة جهة تواصل',exact:true}).click();
  await page.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true}).fill('صاحب الكارت');
  await page.getByRole('textbox',{name:'الصلة بالطالب 1',exact:true}).fill('الطالب نفسه');
  const phone=`000${Date.now()}`; await page.getByRole('textbox',{name:'هاتف جهة التواصل 1',exact:true}).fill(phone);
  const name = `طالب كارت ${Date.now()}`; const code = `000CARD-${Date.now()}`;
  await page.getByRole('textbox',{name:'اسم الطالب',exact:true}).fill(name);
  await page.getByRole('textbox',{name:'كارت المركز',exact:true}).fill(code);
  const response = page.waitForResponse(r => r.request().method()==='POST' && r.url().endsWith('/students'));
  await page.getByRole('button',{name:'حفظ ملف الطالب',exact:true}).click();
  const student = (await (await response).json()).student; expect(student.manual_code).toBe(code); expect(student.city_id).toBe(cityId); expect(student.contacts[0].phone).toBe(phone);
  await expect(page.getByText(code,{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'العودة إلى ملفات الطلاب',exact:true}).click();
  await page.getByRole('tab',{name:'البحث عن طالب',exact:true}).click();
  await select(page,'طريقة البحث','الرقم الداخلي / الباركود');
  await page.getByRole('textbox',{name:'البحث في جميع الملفات المصرح بها',exact:true}).fill(code);
  await page.getByRole('button',{name:'بحث عن طالب',exact:true}).click();
  await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
  await page.locator(`a[href="/admin/students/${student.id}"]`).first().click();
  await expect(page.getByText(code,{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'تعديل ملف الطالب',exact:true}).click();
  await page.getByRole('textbox',{name:'الصلة بالطالب 1',exact:true}).fill('صلة معدلة');
  await page.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click();
  await expect(page.getByText('صاحب الكارت — صلة معدلة — أساسية',{exact:true})).toBeVisible();
  await expect(page.getByText(cityLabel,{exact:true})).toBeVisible(); await expect(page.getByText(code,{exact:true})).toBeVisible();
});

async function write(page: Page, route: string, method: string, payload: object) {
  return page.evaluate(async ({route, method, payload}) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin' });
    const token = document.cookie.split('; ').find(part => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, {route, method, payload});
}



test('concurrent creates and edits reserve codes and future sequence collisions remain recoverable', async ({page}) => {
  await signIn(page);
  const settings = (await (await page.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
  expect((await write(page,'student-code-settings','PATCH',{enabled:true,label:'كارت متزامن',revision:settings.student_code_revision})).status).toBe(200);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const code = `000RACE-${Date.now()}`;
  const payloads = ['أ','ب'].map(suffix => ({name:`تزامن كارت ${Date.now()} ${suffix}`,branch_ids:[workspace.branches[0].id],request_id:crypto.randomUUID(),manual_code:code}));
  const creations = await Promise.all(payloads.map(payload => write(page,'students','POST',payload)));
  expect(creations.map(row => row.status).sort()).toEqual([201,422]);
  const winner = creations.findIndex(row => row.status === 201); const student = creations[winner].body.student;
  expect((await page.request.get(`${origin}/api/v1/center/students/submissions/${payloads[1-winner].request_id}`)).status()).toBe(404);
  const edit = {name:student.name,branch_ids:[],revision:student.revision};
  const edits = await Promise.all(['أ','ب'].map(suffix => write(page,`students/${student.id}`,'PATCH',{...edit,manual_code:`000EDIT-${Date.now()}-${suffix}`})));
  expect(edits.map(row => row.status).sort()).toEqual([200,409]);
  const current = edits.find(row => row.status === 200)!.body.student;
  try {
  const nextCollision = student.student_number + 2;
  expect((await write(page,`students/${student.id}`,'PATCH',{...edit,revision:current.revision,manual_code:`000${nextCollision}`})).status).toBe(200);
  const follower = await write(page,'students','POST',{name:`قبل التعارض ${Date.now()}`,branch_ids:[workspace.branches[0].id],request_id:crypto.randomUUID()});
  expect(follower.status).toBe(201); expect(follower.body.student.student_number).toBe(nextCollision-1);
  const enabled = (await (await page.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
  expect((await write(page,'student-code-settings','PATCH',{enabled:false,label:'كارت متزامن',revision:enabled.student_code_revision})).status).toBe(200);
  await page.goto(`${origin}/admin/students/new`);
  const name = `استرداد رقم ${Date.now()}`; await page.getByRole('textbox',{name:'اسم الطالب',exact:true}).fill(name);
  await page.getByRole('button',{name:'حفظ ملف الطالب',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'الرقم التالي يتعارض'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'اسم الطالب',exact:true})).toHaveValue(name);
  await expect(page.getByRole('button',{name:'حفظ ملف الطالب',exact:true})).toBeEnabled();
  const numbering = (await (await page.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
  expect((await write(page,'student-numbering','PATCH',{start:nextCollision+1,revision:numbering.student_number_revision})).status).toBe(200);
  const response = page.waitForResponse(r => r.request().method()==='POST' && r.url().endsWith('/students'));
  await page.getByRole('button',{name:'حفظ ملف الطالب',exact:true}).click();
  const recovered = (await (await response).json()).student; expect(recovered.student_number).toBe(nextCollision+1);
  await expect(page).toHaveURL(new RegExp(`/students/${recovered.id}\\?focus=edit$`));
  const unchanged = (await (await page.request.get(`${origin}/api/v1/center/students/${student.id}`)).json()).students[0];
  expect(unchanged.student_number).toBe(student.student_number); expect(unchanged.manual_code).toBe(`000${nextCollision}`);
  } finally {
    const settings=(await (await page.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
    if (!settings.student_code_enabled) await write(page,'student-code-settings','PATCH',{enabled:true,label:settings.student_code_label,revision:settings.student_code_revision});
    const row=(await (await page.request.get(`${origin}/api/v1/center/students/${student.id}`)).json()).students[0];
    await write(page,`students/${student.id}`,'PATCH',{name:row.name,branch_ids:[],revision:row.revision,manual_code:current.manual_code});
  }

});

test('disabled codes retain values; code search and writes enforce current branch and center grants', async ({browser}) => {
  const owner=await browser.newPage(); const staff=await browser.newPage(); const beta=await browser.newPage();
  await signIn(owner); await signIn(staff,'staff'); await signIn(beta,'beta');
  const settings=(await (await owner.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
  expect((await write(owner,'student-code-settings','PATCH',{enabled:true,label:'كارت الوصول',revision:settings.student_code_revision})).status).toBe(200);
  const workspace=(await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json());
  const north=workspace.branches.find((branch:{slug:string})=>branch.slug==='north'); const south=workspace.branches.find((branch:{slug:string})=>branch.slug==='south');
  const members=(await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json()).members;
  const member=members.find((member:{user:{email:string}})=>member.user.email===credentials.staff.email);
  const code=`000PRIVATE-${Date.now()}`;
  const result=await write(owner,'students','POST',{name:`صاحب محجوب ${Date.now()}`,branch_ids:[north.id],request_id:crypto.randomUUID(),manual_code:code}); expect(result.status).toBe(201);
  const student=result.body.student;
  expect((await beta.request.get(`${origin.replace('alpha.','beta.')}/api/v1/center/students/${student.id}`)).status()).toBe(404);
  expect((await (await beta.request.get(`${origin.replace('alpha.','beta.')}/api/v1/center/student-workspace?identifier=${code}`)).json()).students).toEqual([]);
  try {
    expect((await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:[],branch_roles:{[south.id]:['registration']}})).status).toBe(200);
    expect((await (await staff.request.get(`${origin}/api/v1/center/student-workspace?identifier=${code}`)).json()).students).toEqual([]);
    const duplicate=await write(staff,'students','POST',{name:'مكرر مخول',branch_ids:[south.id],request_id:crypto.randomUUID(),manual_code:code});
    expect(duplicate.status).toBe(422); expect(JSON.stringify(duplicate.body)).not.toContain(student.name);
    expect((await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:[],branch_roles:{[north.id]:['registration']}})).status).toBe(200);
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    await staff.getByRole('textbox',{name:'كارت الوصول',exact:true}).fill('000مسودة');
    expect((await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:[],branch_roles:{[north.id]:['attendance']}})).status).toBe(200);
    await staff.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click();
    await expect(staff.getByRole('alert')).toBeVisible(); await expect(staff.getByRole('textbox',{name:'كارت الوصول',exact:true})).toHaveValue('000مسودة');
    const current=(await (await owner.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
    expect((await write(owner,'student-code-settings','PATCH',{enabled:false,label:'كارت محفوظ',revision:current.student_code_revision})).status).toBe(200);
    await owner.goto(`${origin}/admin/students/${student.id}/edit`);
    await expect(owner.getByRole('textbox',{name:'كارت محفوظ',exact:true})).toHaveCount(0);
    await expect(owner.getByText('كارت محفوظ — معطل، والقيمة محفوظة:',{exact:false})).toContainText(code);
    await owner.getByRole('textbox',{name:'جهة العمل',exact:true}).fill('تعديل والرمز معطل');
    await owner.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click();
    await expect(owner.getByText(code,{exact:true})).toBeVisible();
    expect((await (await owner.request.get(`${origin}/api/v1/center/student-workspace?identifier=${code}`)).json()).students).toEqual([]);
  } finally {
    await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:member.center_roles,branch_roles:member.branch_roles});
    await owner.close(); await staff.close(); await beta.close();
  }
});

test('settings conflict recovers through the correct header form and RTL themes work on mobile', async ({page}) => {
  await signIn(page); await page.getByRole('link',{name:'إعدادات المركز',exact:true}).click();
  const label=page.getByRole('textbox',{name:'اسم الباركود الإضافي',exact:true});
  await label.fill(''); await page.getByRole('button',{name:'حفظ إعداد الباركود الإضافي',exact:true}).click(); await expect(label).toBeFocused();
  await label.fill('مسودة الكارت');
  await page.goBack();
  await expect(page.getByRole('alertdialog')).toContainText('مغادرة دون حفظ');
  await page.getByRole('alertdialog').getByRole('button',{name:'إلغاء',exact:true}).click();
  await expect(page).toHaveURL(`${origin}/admin/settings`);
  await expect(label).toHaveValue('مسودة الكارت');
  const current=(await (await page.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
  expect((await write(page,'student-code-settings','PATCH',{enabled:true,label:'إعداد أحدث',revision:current.student_code_revision})).status).toBe(200);
  await page.getByRole('button',{name:'حفظ إعداد الباركود الإضافي',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'تغير إعداد الباركود الإضافي'})).toBeVisible(); await expect(label).toHaveValue('مسودة الكارت');
  await expect(page.getByRole('button',{name:'حفظ إعداد الباركود الإضافي',exact:true})).toBeDisabled();
  const recovery=page.getByRole('button',{name:'تحميل إعداد الباركود الحالي',exact:true}); expect(await recovery.evaluate(button=>Boolean(button.closest('header')))).toBe(true);
  await recovery.click(); await expect(label).toHaveValue('إعداد أحدث');
  await label.fill('كارت لوحة المفاتيح');
  const save=page.getByRole('button',{name:'حفظ إعداد الباركود الإضافي',exact:true});
  expect(await save.evaluate(button=>button instanceof HTMLButtonElement && button.form?.getAttribute('aria-label'))).toBe('إعداد الباركود الإضافي');
  await save.click(); await expect(page.getByRole('status').filter({hasText:'حُفظ إعداد الباركود الإضافي'})).toBeVisible();
  await page.screenshot({path:'/tmp/courses-issue57/codes-settings-desktop-light.png',fullPage:true});
  await page.getByRole('button',{name:'تفعيل الوضع الداكن'}).click(); await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.screenshot({path:'/tmp/courses-issue57/codes-settings-desktop-dark.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844}); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/courses-issue57/codes-settings-mobile-dark.png',fullPage:true});
  await label.fill('قيمة ملغاة'); await page.getByRole('button',{name:'إلغاء إعداد الباركود',exact:true}).click(); await expect(label).toHaveValue('كارت لوحة المفاتيح');
});

test('ordinary SSR code settings, create, profile, edit and scan remain at six measured SQL queries', async ({page}) => {
  test.skip(!process.env.COURSES_CODES_READ_LOG,'Requires the SSR read log.');
  const log=process.env.COURSES_CODES_READ_LOG!;
  const cursor=()=>readFileSync(log,'utf8').split('\n').filter(Boolean).length;
  const reads=(start:number)=>readFileSync(log,'utf8').split('\n').filter(Boolean).slice(start).map(line=>JSON.parse(line)).filter(row=>row.host?.startsWith('alpha.') && row.path?.startsWith('/api/v1/center/')) as {count:number|null}[];
  await signIn(page);
  const settings=(await (await page.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
  expect((await write(page,'student-code-settings','PATCH',{enabled:true,label:'كارت مقاس',revision:settings.student_code_revision})).status).toBe(200);
  const workspace=(await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json());
  const result=await write(page,'students','POST',{name:`قياس باركود ${Date.now()}`,manual_code:`000MEASURE-${Date.now()}`,branch_ids:[workspace.branches[0].id],request_id:crypto.randomUUID()}); expect(result.status).toBe(201); const student=result.body.student;
  for (const route of ['/admin/settings','/admin/students/new',`/admin/students/${student.id}`,`/admin/students/${student.id}/edit`,`/admin/students?identifier=${student.manual_code}`]) {
    const start=cursor(); await page.goto(`${origin}${route}`); await expect(page.getByRole('heading',{level:1})).toBeVisible();
    const rows=reads(start); expect(rows.length).toBeGreaterThan(0); expect(rows.every(row=>typeof row.count==='number' && row.count>0)).toBe(true);
    const sql=rows.reduce((sum,row)=>sum+(row.count??Number.NaN),0); expect(sql).toBeLessThanOrEqual(6); console.log(JSON.stringify({route,sql}));
  }
  await page.locator('.center-topbar').evaluate(element=>element.setAttribute('data-code-shell','retained'));
  const documents:string[]=[]; page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
  const start=cursor(); const link=page.locator(`a[href="/admin/students/${student.id}"]`).first(); await link.hover(); await expect.poll(()=>reads(start).length).toBeGreaterThan(0); await link.click();
  await expect(page.getByText(student.manual_code,{exact:true})).toBeVisible(); await expect(page.locator('.center-topbar')).toHaveAttribute('data-code-shell','retained'); expect(documents).toEqual([]);
  const rows=reads(start); expect(rows.every(row=>typeof row.count==='number' && row.count>0)).toBe(true); expect(rows.reduce((sum,row)=>sum+(row.count??Number.NaN),0)).toBeLessThanOrEqual(6);
});

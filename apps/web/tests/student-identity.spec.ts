import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.skip(!process.env.COURSES_IDENTITY_CREDENTIALS, 'Requires the disposable identity PostgreSQL fixture.');
const origin = process.env.COURSES_IDENTITY_ORIGIN ?? 'http://alpha.courses.test:8057';
const credentials = process.env.COURSES_IDENTITY_CREDENTIALS ? JSON.parse(readFileSync(process.env.COURSES_IDENTITY_CREDENTIALS, 'utf8')) : {};
async function signIn(page: Page, who = 'alpha') {
  await page.goto(`${who === 'beta' ? origin.replace('alpha.', 'beta.') : origin}/login`);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).pressSequentially(credentials[who].email);
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).pressSequentially(credentials[who].password);
  await page.getByRole('button', { name: 'دخول المركز', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
async function write(page: Page, route: string, method: string, payload: object) {
  return page.evaluate(async ({route,method,payload}) => {
    await fetch('/sanctum/csrf-cookie',{credentials:'same-origin',cache:'no-store'});
    const token=document.cookie.split('; ').find(part=>part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response=await fetch(`/api/v1/center/${route}`,{method,credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json','X-XSRF-TOKEN':decodeURIComponent(token??'')},body:JSON.stringify(payload)});
    return {status:response.status,body:await response.json()};
  },{route,method,payload});
}
const syntheticId = (birth = '3000229') => birth + String(Date.now() % 10000000).padStart(7,'0');

test('owner reviews extracted birth before saving and identity edits preserve contacts and manual barcode', async ({page}) => {
  await signIn(page);
  const settings=(await (await page.request.get(`${origin}/api/v1/center/settings`)).json()).settings;
  expect((await write(page,'student-code-settings','PATCH',{enabled:true,label:'كارت الهوية',revision:settings.student_code_revision})).status).toBe(200);
  await page.goto(`${origin}/admin/students/new`);
  const national=syntheticId(); const card=`000-IDENTITY-${Date.now()}`; const passport='000A-SYNTHETIC'; const phone=`000${Date.now()}`;
  await page.getByRole('textbox',{name:'اسم الطالب',exact:true}).fill(`هوية اصطناعية ${Date.now()}`);
  await page.getByRole('textbox',{name:'تاريخ الميلاد',exact:true}).fill('2000-03-01');
  await page.getByRole('textbox',{name:'الرقم القومي المصري',exact:true}).fill(national);
  await page.getByRole('textbox',{name:'رقم جواز السفر',exact:true}).fill(passport);
  await page.getByRole('textbox',{name:'كارت الهوية',exact:true}).fill(card);
  const review=page.getByRole('button',{name:'مراجعة الميلاد من الرقم القومي',exact:true});
  expect(await review.evaluate(button=>Boolean(button.closest('header')))).toBe(true);
  await review.click();
  await expect(page.getByText('الميلاد المستخرج: 2000-02-29',{exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'تاريخ الميلاد',exact:true})).toHaveValue('2000-03-01');
  await expect(page.getByText('تعارض مع تاريخ الميلاد المدخل. صحح الرقم أو اختر استخدام الميلاد المستخرج.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'استخدام الميلاد المستخرج',exact:true}).click();
  await page.getByRole('button',{name:'إضافة جهة تواصل',exact:true}).click();
  await page.getByRole('textbox',{name:'اسم جهة التواصل 1',exact:true}).fill('صاحب الهوية الاصطناعية');
  await page.getByRole('textbox',{name:'الصلة بالطالب 1',exact:true}).fill('الطالب نفسه');
  await page.getByRole('textbox',{name:'هاتف جهة التواصل 1',exact:true}).fill(phone);
  const response=page.waitForResponse(response=>response.url().endsWith('/api/v1/center/students') && response.request().method()==='POST');
  await page.getByRole('button',{name:'حفظ ملف الطالب',exact:true}).click();
  const student=(await (await response).json()).student;
  await expect(page).toHaveURL(new RegExp(`/admin/students/${student.id}\\?focus=edit$`));
  await expect(page.getByText(national,{exact:true})).toBeVisible(); await expect(page.getByText(passport,{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'تعديل ملف الطالب',exact:true}).click();
  await page.getByRole('textbox',{name:'رقم جواز السفر',exact:true}).fill('000B-SYNTHETIC');
  await page.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click();
  await expect(page.getByText('000B-SYNTHETIC',{exact:true})).toBeVisible();
  const current=(await (await page.request.get(`${origin}/api/v1/center/students/${student.id}`)).json()).students[0];
  expect(current.manual_code).toBe(card); expect(current.student_number).toBe(student.student_number); expect(current.contacts[0].phone).toBe(phone); expect(current.date_of_birth).toBe('2000-02-29');
});

test('concurrent identity creates and edits stay unique and another center can use the same synthetic identity', async ({browser}) => {
  const owner=await browser.newPage(); const beta=await browser.newPage();
  try {
    await signIn(owner); await signIn(beta,'beta');
    const workspace=(await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json());
    const branches=[workspace.branches[0].id]; const national=syntheticId();
    const payload={national_id:national,date_of_birth:'2000-02-29',passport_number:'000SHARED-PASSPORT',branch_ids:branches};
    const raced=await Promise.all([write(owner,'students','POST',{...payload,name:`تزامن هوية أ ${Date.now()}`,request_id:crypto.randomUUID()}),write(owner,'students','POST',{...payload,name:`تزامن هوية ب ${Date.now()}`,request_id:crypto.randomUUID()})]);
    expect(raced.map(result=>result.status).sort()).toEqual([201,422]);
    const winner=raced.find(result=>result.status===201)!.body.student;
    expect(JSON.stringify(raced.find(result=>result.status===422)!.body)).not.toContain(national);
    const another=await write(owner,'students','POST',{name:`جواز متكرر ${Date.now()}`,passport_number:'000SHARED-PASSPORT',branch_ids:branches,request_id:crypto.randomUUID()});
    expect(another.status).toBe(201); expect(another.body.student.age).toBeNull();
    const conflict=await write(owner,`students/${another.body.student.id}`,'PATCH',{name:another.body.student.name,branch_ids:[],revision:1,national_id:national,date_of_birth:'2000-02-29'});
    expect(conflict.status).toBe(422); expect(JSON.stringify(conflict.body)).not.toContain(winner.name);
    const concurrent=await Promise.all(['000P1','000P2'].map(passport=>write(owner,`students/${winner.id}`,'PATCH',{name:winner.name,branch_ids:[],revision:winner.revision,passport_number:passport})));
    expect(concurrent.map(result=>result.status).sort()).toEqual([200,409]);
    const emptyProfiles=await Promise.all(['أ','ب'].map(name=>write(owner,'students','POST',{name:`هوية تعديل متزامن ${name} ${Date.now()}`,branch_ids:branches,request_id:crypto.randomUUID()})));
    const editId=syntheticId('3010101');
    const uniqueEdits=await Promise.all(emptyProfiles.map(result=>write(owner,`students/${result.body.student.id}`,'PATCH',{name:result.body.student.name,branch_ids:[],revision:1,national_id:editId,date_of_birth:'2001-01-01'})));
    expect(uniqueEdits.map(result=>result.status).sort()).toEqual([200,422]);
    const betaOrigin=origin.replace('alpha.','beta.');
    const betaWorkspace=(await (await beta.request.get(`${betaOrigin}/api/v1/center/student-workspace`)).json());
    expect((await write(beta,'students','POST',{...payload,name:`هوية مستقلة ${Date.now()}`,branch_ids:[betaWorkspace.branches[0].id],request_id:crypto.randomUUID()})).status).toBe(201);
    expect((await beta.request.get(`${betaOrigin}/api/v1/center/students/${winner.id}`)).status()).toBe(404);
  } finally {await owner.close();await beta.close();}
});

test('owner grants identity in the member UI and revocation blocks the next open-editor request without leaking or erasing values', async ({browser}) => {
  const owner=await browser.newPage(); const staff=await browser.newPage(); let member: {id:number;center_roles:string[];branch_roles:Record<string,string[]>} | undefined;
  try {
    await signIn(owner); await signIn(staff,'staff');
    const workspace=(await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json());
    member=workspace.members.find((row:{user:{email:string}})=>row.user.email===credentials.staff.email);
    const north=workspace.branches.find((branch:{slug:string})=>branch.slug==='north'); const south=workspace.branches.find((branch:{slug:string})=>branch.slug==='south');
    expect((await write(owner,`members/${member!.id}/grants`,'PUT',{center_roles:[],branch_roles:{[north.id]:['registration','branch_auditor']}})).status).toBe(200);
    const national=syntheticId(); const passport=`000PRIVATE-${Date.now()}`;
    const created=await write(owner,'students','POST',{name:`هوية خصوصية ${Date.now()}`,branch_ids:[north.id],request_id:crypto.randomUUID(),national_id:national,passport_number:passport,date_of_birth:'2000-02-29'});
    expect(created.status).toBe(201); const student=created.body.student;
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    await expect(staff.getByRole('textbox',{name:'الرقم القومي المصري',exact:true})).toHaveCount(0);
    expect(await staff.content()).not.toContain(national); expect(await staff.content()).not.toContain(passport);
    const hidden=(await (await staff.request.get(`${origin}/api/v1/center/students/${student.id}`)).json());
    expect(hidden.students[0].identity).toBeUndefined(); expect(JSON.stringify(hidden)).not.toContain(passport);
    await staff.getByRole('textbox',{name:'جهة العمل',exact:true}).fill('تعديل عام مع هوية محجوبة');
    await staff.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click();
    await expect(staff).toHaveURL(new RegExp(`/admin/students/${student.id}\\?focus=edit$`));
    expect((await write(staff,`students/${student.id}`,'PATCH',{name:student.name,branch_ids:[],revision:2,passport_number:null})).status).toBe(403);
    expect((await write(staff,'students/identity-preview','POST',{student_id:student.id,branch_ids:[],national_id:national})).status).toBe(403);
    for (const route of [`students/${student.id}/barcode`,'audit',`students/similar?name=${encodeURIComponent(student.name)}`,'student-search-workspace']) {
      const response=await staff.request.get(`${origin}/api/v1/center/${route}`); expect(await response.text()).not.toContain(national); expect(await response.text()).not.toContain(passport);
    }
    await owner.goto(`${origin}/admin/members`);
    await owner.getByRole('row').filter({hasText:credentials.staff.email}).getByRole('button',{name:'تعديل الأدوار',exact:true}).click();
    await owner.getByRole('group',{name:north.name,exact:true}).getByRole('checkbox',{name:'بيانات هوية الطالب',exact:true}).check();
    const save=owner.getByRole('button',{name:'حفظ الأدوار',exact:true}); expect(await save.evaluate(button=>Boolean(button.closest('header')))).toBe(true); await save.click();
    await owner.getByRole('alertdialog').getByRole('button',{name:'حفظ التغيير',exact:true}).click();
    await expect(owner.getByRole('status').filter({hasText:'حُفظت أدوار الموظف'})).toBeVisible();
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    await expect(staff.getByRole('textbox',{name:'رقم جواز السفر',exact:true})).toHaveValue(passport);
    await staff.getByRole('textbox',{name:'رقم جواز السفر',exact:true}).fill('000مسودة محجوبة');
    expect((await write(owner,`members/${member!.id}/grants`,'PUT',{center_roles:[],branch_roles:{[north.id]:['registration','branch_auditor']}})).status).toBe(200);
    const denied=staff.waitForResponse(response=>response.url().endsWith(`/students/${student.id}`)&&response.request().method()==='PATCH');
    await staff.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click(); expect((await denied).status()).toBe(403);
    await expect(staff.getByRole('textbox',{name:'رقم جواز السفر',exact:true})).toHaveValue('000مسودة محجوبة');
    const current=(await (await owner.request.get(`${origin}/api/v1/center/students/${student.id}`)).json()).students[0];
    expect(current.identity.passport_number).toBe(passport); expect(current.identity.national_id).toBe(national); expect(current.employer).toBe('تعديل عام مع هوية محجوبة');
    expect((await write(owner,`members/${member!.id}/grants`,'PUT',{center_roles:[],branch_roles:{[south.id]:['registration','student_identity']}})).status).toBe(200);
    expect((await staff.request.get(`${origin}/api/v1/center/students/${student.id}`)).status()).toBe(404);
    expect((await write(staff,`students/${student.id}`,'PATCH',{name:student.name,branch_ids:[],revision:2,national_id:null})).status).toBe(404);
  } finally {
    if(member) await write(owner,`members/${member.id}/grants`,'PUT',{center_roles:member.center_roles,branch_roles:member.branch_roles});
    await owner.close();await staff.close();
  }
});

test('identity preview validates fields, retains saved birth, and cancellation works in RTL themes and mobile', async ({page}) => {
  await signIn(page); await page.goto(`${origin}/admin/students`);
  await page.locator('.center-topbar').getByRole('link',{name:'إنشاء ملف طالب',exact:true}).click();
  const name=page.getByRole('textbox',{name:'اسم الطالب',exact:true}); await expect(name).toBeFocused(); await name.fill(`تحقق هوية ${Date.now()}`);
  const national=page.getByRole('textbox',{name:'الرقم القومي المصري',exact:true}); const birth=page.getByRole('textbox',{name:'تاريخ الميلاد',exact:true});
  const review=page.getByRole('button',{name:'مراجعة الميلاد من الرقم القومي',exact:true});
  await national.fill(syntheticId()); await birth.fill('2001-02-29'); await review.click();
  await expect(birth).toBeFocused(); await expect(birth).toHaveAttribute('aria-invalid','true');
  await birth.fill('');
  for (const value of ['30102310100001','39901010100001','40002290100001']) {
    await national.fill(value); await review.click(); await expect(national).toBeFocused(); await expect(national).toHaveAttribute('aria-invalid','true'); await expect(national).toHaveValue(value);
  }
  await national.fill(syntheticId()); await review.click(); await expect(page.getByText('الميلاد المستخرج: 2000-02-29',{exact:true})).toBeVisible();
  await expect(birth).toHaveValue(''); await page.getByRole('button',{name:'استخدام الميلاد المستخرج',exact:true}).click(); await expect(birth).toHaveValue('2000-02-29');
  await page.screenshot({path:'/tmp/courses-issue57/identity-desktop-light.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'تفعيل الوضع الداكن',exact:true}).click();
  await page.screenshot({path:'/tmp/courses-issue57/identity-desktop-dark.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844}); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/courses-issue57/identity-mobile-dark.png',fullPage:true,animations:'disabled'});
  await page.goBack(); await expect(page.getByRole('alertdialog')).toContainText('مغادرة دون حفظ'); await page.getByRole('alertdialog').getByRole('button',{name:'إلغاء',exact:true}).click();
  await expect(birth).toHaveValue('2000-02-29');
  await page.locator('.center-topbar').getByRole('link',{name:'إلغاء',exact:true}).click(); await page.getByRole('alertdialog').getByRole('button',{name:'مغادرة دون حفظ',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/students\?focus=create$/);
  const workspace=(await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json());
  const saved=await write(page,'students','POST',{name:`ميلاد محفوظ ${Date.now()}`,branch_ids:[workspace.branches[0].id],date_of_birth:'2000-03-01',request_id:crypto.randomUUID()}); expect(saved.status).toBe(201);
  await page.goto(`${origin}/admin/students/${saved.body.student.id}/edit`); await national.fill(syntheticId()); await review.click();
  await expect(page.getByText('تعارض مع الميلاد المحفوظ: 2000-03-01. لم يتغير التاريخ المحفوظ.',{exact:true})).toBeVisible(); await expect(birth).toHaveValue('2000-03-01');
  const failed=page.waitForResponse(response=>response.url().endsWith(`/students/${saved.body.student.id}`)&&response.request().method()==='PATCH');
  await page.getByRole('button',{name:'حفظ بيانات الطالب',exact:true}).click(); expect((await failed).status()).toBe(422);
  await expect(birth).toBeFocused(); expect((await (await page.request.get(`${origin}/api/v1/center/students/${saved.body.student.id}`)).json()).students[0].date_of_birth).toBe('2000-03-01');
});

test('identity profile SSR and warm navigation retain the shell within six measured SQL queries', async ({page}) => {
  test.skip(!process.env.COURSES_IDENTITY_READ_LOG,'Requires the SSR read log.');
  const log=process.env.COURSES_IDENTITY_READ_LOG!;
  const cursor=()=>readFileSync(log,'utf8').split('\n').filter(Boolean).length;
  const reads=(start:number)=>readFileSync(log,'utf8').split('\n').filter(Boolean).slice(start).map(line=>JSON.parse(line)).filter(row=>row.host?.startsWith('alpha.') && row.path?.startsWith('/api/v1/center/')) as {count:number|null}[];
  await signIn(page);
  const workspace=(await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json());
  const result=await write(page,'students','POST',{name:`قياس هوية ${Date.now()}`,national_id:syntheticId(),date_of_birth:'2000-02-29',passport_number:'000SQL-SYNTHETIC',branch_ids:[workspace.branches[0].id],request_id:crypto.randomUUID()}); expect(result.status).toBe(201); const student=result.body.student;
  for (const route of ['/admin/members','/admin/students','/admin/students/new',`/admin/students/${student.id}`,`/admin/students/${student.id}/edit`,`/admin/students?q=${encodeURIComponent(student.name)}`]) {
    const start=cursor(); await page.goto(`${origin}${route}`); await expect(page.getByRole('heading',{level:1})).toBeVisible();
    const rows=reads(start); expect(rows.length).toBeGreaterThan(0); expect(rows.every(row=>typeof row.count==='number' && row.count>0)).toBe(true); const sql=rows.reduce((sum,row)=>sum+(row.count??Number.NaN),0); expect(sql).toBeLessThanOrEqual(6); console.log(JSON.stringify({route,sql}));
  }
  await page.locator('.center-topbar').evaluate(element=>element.setAttribute('data-identity-shell','retained'));
  const documents:string[]=[]; page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
  const start=cursor(); const link=page.locator(`a[href="/admin/students/${student.id}"]`).first(); await link.hover(); await expect.poll(()=>reads(start).length).toBeGreaterThan(0); await link.click();
  await expect(page.getByText(student.identity.national_id,{exact:true})).toBeVisible(); await expect(page.locator('.center-topbar')).toHaveAttribute('data-identity-shell','retained'); expect(documents).toEqual([]);
  const rows=reads(start); expect(rows.every(row=>typeof row.count==='number'&&row.count>0)).toBe(true); expect(rows.reduce((sum,row)=>sum+(row.count??Number.NaN),0)).toBeLessThanOrEqual(6);
});

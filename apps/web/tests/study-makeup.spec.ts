import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

test.skip(!process.env.COURSES_TRANSFER_CREDENTIALS || !process.env.COURSES_TRANSFER_QUERY_LOG || !process.env.COURSES_TRANSFER_DB_PORT,
  'Requires the disposable center and SSR query log.');
test.setTimeout(120_000);
const origin = process.env.COURSES_TRANSFER_ORIGIN ?? 'http://alpha.courses.test:8658';
const credentials = process.env.COURSES_TRANSFER_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_TRANSFER_CREDENTIALS, 'utf8')) : {};

async function signIn(page: Page, who: 'alpha' | 'staff') {
  await page.goto(`${origin}/login`);
  await page.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(credentials[who].email);
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).fill(credentials[who].password);
  await page.getByRole('button', { name: 'دخول المركز', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, route: string, payload: object, method = 'POST') {
  return page.evaluate(async ({ route, payload, method }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find(part => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

function queryRows() {
  const path = process.env.COURSES_TRANSFER_QUERY_LOG!;
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { path: string; count: number | null }) : [];
}

test('books makeup without granting coverage and hides the attempt from unauthorized staff', async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, 'alpha');
    const centerId = (await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json()).center.id as string;
    expect(centerId).toMatch(/^[a-f0-9-]{36}$/);
    const stamp = Date.now();
    const branch = await write(owner, 'branches', { name: `Makeup branch ${stamp}`, slug: `makeup-${stamp}` });
    expect(branch.status).toBe(201);
    const branchId = branch.body.branch.id;
    const course = await write(owner, 'courses', { branch_id: branchId, name: `Makeup course ${stamp}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: 'Stage', request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: 'Level',
      lectures: [{ number: 1, content: 'Lecture 1', planned_hours: 1 }], request_id: crypto.randomUUID() });
    expect(level.status).toBe(201);
    const instructor = await write(owner, 'instructors', { name: `Teacher ${stamp}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    async function group(name: string) {
      const result = await write(owner, 'groups', { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
        name, approved_price: '100.00', instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
      expect(result.status).toBe(201);
      return result.body.group;
    }
    const source = await group(`Source ${stamp}`);
    const target = await group(`Target ${stamp}`);
    const scheduled = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10) + 'T17:00';
    const session = await write(owner, `groups/${target.id}/sessions`, { kind: 'single', revision: target.revision,
      start_at: scheduled, plan_lecture_number: 1, request_id: crypto.randomUUID() });
    expect(session.status).toBe(201);
    const sessionId = session.body.sessions[0].id;
    const student = await write(owner, 'students', { name: `طالب تعويض ${stamp}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const studentId = student.body.student.id;
    const account = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
    if (!account.account.currency) {
      expect((await write(owner, 'financial-currency', { currency: 'EGP', revision: account.account.currency_revision }, 'PATCH')).status).toBe(200);
    }
    const enrollments = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
    const enrolled = await write(owner, `students/${studentId}/enrollments`, {
      group_id: source.id, group_revision: source.revision, currency_revision: enrollments.student.currency_revision,
      joined_on: new Date(Date.now() - 3 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Africa/Cairo' }),
      discount: '0.00', discount_reason: null,
      version: enrollments.student.version, request_id: crypto.randomUUID(),
    });
    expect(enrolled.status).toBe(201);
    const attemptId = enrolled.body.attempt.id;
    const start = queryRows().length;
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`${origin}/admin/students/${studentId}/enrollments`);
    await expect(owner.getByRole('table', { name: 'محاولات الدراسة' })).toBeVisible();
    expect(await owner.locator('html').getAttribute('dir')).toBe('rtl');
    const reads = queryRows().slice(start).filter(row => row.path.startsWith('/api/v1/center/'));
    expect(reads.reduce((sum, row) => sum + (row.count ?? 0), 0)).toBeLessThanOrEqual(6);
    const optionsResponse = owner.waitForResponse(response => response.url().includes(`/enrollments/${attemptId}/makeup?page=`));
    await owner.locator(`[id$="-makeup-${attemptId}"]`).click();
    const editor = owner.getByRole('region', { name: 'حضور التعويض' });
    await expect(editor).toBeVisible();
    const options = await optionsResponse;
    expect(Number(options.headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    await owner.getByRole('searchbox', { name: 'بحث في محاضرات التعويض' }).fill(target.name);
    const filteredResponse = owner.waitForResponse(response => response.url().includes('/makeup?page=1&q='));
    await owner.getByRole('button', { name: 'بحث في جميع محاضرات التعويض' }).click();
    expect(Number((await filteredResponse).headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    await expect(editor.getByRole('row').filter({ hasText: target.name })).toBeVisible();
    await owner.getByRole('button', { name: 'القائمة' }).click();
    await owner.getByRole('button', { name: 'تفعيل الوضع الداكن' }).click();
    await expect(owner.locator('html')).toHaveAttribute('data-theme', 'dark');
    await owner.getByRole('button', { name: 'إغلاق القائمة' }).click();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const row = editor.getByRole('row').filter({ hasText: target.name });
    await row.getByRole('button', { name: 'حجز تعويض' }).click();
    await owner.getByRole('button', { name: 'تأكيد حجز التعويض' }).click();
    await expect(editor.getByText('حُجز التعويض. لا تُحسب التغطية حتى تسجيل الحضور المحتسب.')).toBeVisible();
    const coverage = await owner.request.get(`${origin}/api/v1/center/groups/${source.id}/coverage`);
    expect(Number(coverage.headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    expect((await coverage.json()).students[0].covered_count).toBe(0);
    const roster = await owner.request.get(`${origin}/api/v1/center/groups/${target.id}/sessions/${sessionId}/attendance`);
    expect(Number(roster.headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    expect((await roster.json()).students[0]).toMatchObject({ attempt_id: attemptId, status: null });
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(target.id).toMatch(/^[a-f0-9-]{36}$/);
    expect((await write(owner, `groups/${target.id}/start`, { revision: session.body.group_revision })).status).toBe(200);
    execFileSync('psql', ['-h', '127.0.0.1', '-p', process.env.COURSES_TRANSFER_DB_PORT!, '-U', 'postgres',
      '-d', `courses_center_${centerId}`, '-c',
      `UPDATE study_groups SET started_at = now() - interval '2 days' WHERE id = '${target.id}'; UPDATE study_sessions SET scheduled_at = now() - interval '1 day' WHERE id = '${sessionId}'`], { stdio: 'ignore' });
    expect((await write(owner, `groups/${target.id}/sessions/${sessionId}/close`, {
      revision: session.body.sessions[0].revision, request_id: crypto.randomUUID(),
    })).status).toBe(200);
    const attempt = (await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json()).attempts[0];
    expect((await write(owner, `students/${studentId}/enrollments/${attemptId}/withdraw`, {
      withdrawn_on: new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Cairo' }),
      revision: attempt.revision, reason: 'انسحاب بعد محاضرة التعويض', request_id: crypto.randomUUID(),
    })).status).toBe(200);
    await owner.goto(`${origin}/admin/students/${studentId}/enrollments`);
    await expect(owner.locator(`[id$="-makeup-${attemptId}"]`)).toBeVisible();
    await owner.locator(`[id$="-makeup-${attemptId}"]`).click();
    const historical = owner.getByRole('region', { name: 'حضور التعويض' });
    const historicalProof = historical.locator(`[id$="-select-${sessionId}"]`);
    await expect(historicalProof).toBeVisible();
    const historicalOptions = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments/${attemptId}/makeup`)).json();
    expect(historicalOptions.sessions[0]).toMatchObject({ id: sessionId, can_book: false, can_prove: true });
    await historicalProof.click();
    await historical.getByLabel('سبب إثبات الحضور بعد الإغلاق').fill('إثبات حضور سابق للانسحاب');
    await owner.getByRole('button', { name: 'حفظ إثبات التعويض' }).click();
    await expect(historical.getByText('ثُبت حضور التعويض في المحاضرة المغلقة مع السبب وسجل التدقيق.')).toBeVisible();
    const completed = await owner.request.get(`${origin}/api/v1/center/groups/${source.id}/coverage`);
    expect(Number(completed.headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    expect((await completed.json()).students[0].covered_count).toBe(1);
    await signIn(staff, 'staff');
    expect((await staff.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments/${attemptId}/makeup`)).status()).toBe(404);
  } finally { await owner.close(); await staff.close(); }
});

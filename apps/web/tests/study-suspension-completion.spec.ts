import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test.skip(!process.env.COURSES_TRANSFER_CREDENTIALS || !process.env.COURSES_TRANSFER_QUERY_LOG || !process.env.COURSES_TRANSFER_DB_PORT,
  'Requires an isolated center, browser credentials, and an SSR query log.');
test.setTimeout(120_000);
const origin = process.env.COURSES_TRANSFER_ORIGIN ?? 'http://alpha.courses.test:8658';
const credentials = process.env.COURSES_TRANSFER_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_TRANSFER_CREDENTIALS, 'utf8')) : {};

async function write(page: Page, route: string, payload: object) {
  return page.evaluate(async ({ route, payload }) => {
    await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin', cache: 'no-store' });
    const token = document.cookie.split('; ').find(part => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        'X-XSRF-TOKEN': decodeURIComponent(token ?? '') }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload });
}

function backdate(centerId: string, sql: string) {
  execFileSync('psql', ['-h', '127.0.0.1', '-p', process.env.COURSES_TRANSFER_DB_PORT!, '-U', 'postgres',
    '-d', `courses_center_${centerId}`, '-c', sql], { stdio: 'ignore' });
}

async function assertPageQueries(path: string, since: number) {
  const rowsForPage = () => readFileSync(process.env.COURSES_TRANSFER_QUERY_LOG!, 'utf8').trim().split('\n').slice(since)
    .map(line => JSON.parse(line) as { path: string; count: number | null }).filter(row => row.path === `/api/v1/center/${path}`);
  await expect.poll(() => rowsForPage().length).toBeGreaterThan(0);
  const rows = rowsForPage();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => Number.isInteger(row.count) && row.count! <= 6)).toBe(true);
}

function logSize() {
  return readFileSync(process.env.COURSES_TRANSFER_QUERY_LOG!, 'utf8').trim().split('\n').length;
}

test('suspension keeps missing content through closure and lift until valid makeup and completion', async ({ browser }) => {
  const owner = await browser.newPage();
  try {
    await owner.goto(`${origin}/login`);
    await owner.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill(credentials.alpha.email);
    await owner.getByRole('textbox', { name: 'كلمة المرور', exact: true }).fill(credentials.alpha.password);
    await owner.getByRole('button', { name: 'دخول المركز', exact: true }).click();
    await expect(owner).toHaveURL(/\/admin$/);
    const centerId = (await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json()).center.id as string;
    const stamp = Date.now();
    const branch = await write(owner, 'branches', { name: `Suspension ${stamp}`, slug: `suspension-${stamp}` });
    expect(branch.status).toBe(201);
    const course = await write(owner, 'courses', { branch_id: branch.body.branch.id, name: `Course ${stamp}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: 'Stage', request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: 'Level',
      lectures: [{ number: 1, content: 'Required content', planned_hours: 1 }], request_id: crypto.randomUUID() });
    expect(level.status).toBe(201);
    const instructor = await write(owner, 'instructors', { name: `Teacher ${stamp}`, branch_ids: [branch.body.branch.id], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    async function group(name: string) {
      const response = await write(owner, 'groups', { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
        name, approved_price: '0.00', instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
      expect(response.status).toBe(201);
      return response.body.group;
    }
    const source = await group(`Source ${stamp}`);
    const target = await group(`Target ${stamp}`);
    const scheduled = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10) + 'T17:00';
    const sourceSession = await write(owner, `groups/${source.id}/sessions`, { kind: 'single', revision: source.revision,
      start_at: scheduled, plan_lecture_number: 1, request_id: crypto.randomUUID() });
    expect(sourceSession.status).toBe(201);
    const targetSession = await write(owner, `groups/${target.id}/sessions`, { kind: 'single', revision: target.revision,
      start_at: scheduled, plan_lecture_number: 1, request_id: crypto.randomUUID() });
    expect(targetSession.status).toBe(201);
    const sourceId = sourceSession.body.sessions[0].id as string;
    const targetId = targetSession.body.sessions[0].id as string;
    const student = await write(owner, 'students', { name: `طالب موقوف ${stamp}`, branch_ids: [branch.body.branch.id], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const studentId = student.body.student.id as string;
    const accountResponse = await owner.request.get(`${origin}/api/v1/center/students/${studentId}/account`);
    const account = await accountResponse.json();
    expect(accountResponse.status(), JSON.stringify(account)).toBe(200);
    if (!account.account.currency) {
      const currency = await owner.evaluate(async (revision: number) => {
        await fetch('/sanctum/csrf-cookie', { credentials: 'same-origin' });
        const token = document.cookie.split('; ').find(part => part.startsWith('XSRF-TOKEN='))?.split('=')[1];
        return fetch('/api/v1/center/financial-currency', { method: 'PATCH', credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(token ?? '') },
          body: JSON.stringify({ currency: 'EGP', revision }) }).then(response => response.status);
      }, account.account.currency_revision);
      expect(currency).toBe(200);
    }
    const enrollments = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
    const enrolled = await write(owner, `students/${studentId}/enrollments`, {
      group_id: source.id, group_revision: sourceSession.body.group_revision,
      currency_revision: enrollments.student.currency_revision, version: enrollments.student.version,
      joined_on: new Date(Date.now() - 6 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Africa/Cairo' }),
      discount: '0.00', discount_reason: null, request_id: crypto.randomUUID(),
    });
    expect(enrolled.status).toBe(201);
    const attemptId = enrolled.body.attempt.id as string;
    expect((await write(owner, `groups/${source.id}/start`, { revision: sourceSession.body.group_revision })).status).toBe(200);
    const suspended = await write(owner, `students/${studentId}/status`, { status: 'suspended', reason: 'إيقاف قبل المحاضرة',
      status_revision: 1, request_id: crypto.randomUUID() });
    expect(suspended.status).toBe(200);
    backdate(centerId, `UPDATE student_suspensions SET suspended_at = now() - interval '4 days' WHERE student_id = '${studentId}' AND lifted_at IS NULL;
      UPDATE study_groups SET started_at = now() - interval '5 days' WHERE id = '${source.id}';
      UPDATE study_sessions SET scheduled_at = now() - interval '3 days' WHERE id = '${sourceId}'`);
    const closed = await write(owner, `groups/${source.id}/sessions/${sourceId}/close`, { revision: 1, request_id: crypto.randomUUID() });
    expect(closed.status).toBe(200);
    expect(closed.body.absent_count).toBe(0);
    const coveragePath = `groups/${source.id}/coverage`;
    const coverageUrl = `${origin}/admin/${coveragePath}`;
    const beforeCoverage = logSize();
    await owner.goto(coverageUrl);
    await expect(owner.getByRole('row', { name: new RegExp(student.body.student.name) })).toContainText('٠/١');
    await assertPageQueries(coveragePath, beforeCoverage);
    await expect(owner.getByText('تحتاج مراجعة: الطالب موقوف')).toBeVisible();
    await expect(owner.getByText('الناقص:')).toBeVisible();
    const missing = await owner.request.get(`${origin}/api/v1/center/${coveragePath}`);
    expect(Number(missing.headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    expect((await missing.json()).students[0]).toMatchObject({ covered_count: 0, required_count: 1, missing_numbers: [1] });
    const coursePath = `students/${studentId}/courses/${course.body.course.id}/completion`;
    await owner.goto(`${origin}/admin/${coursePath}`);
    await expect(owner.getByText('الكورس لم يكتمل دراسيًا')).toBeVisible();
    await expect(owner.getByRole('link', { name: 'تقرير التغطية والنواقص الحالية' })).toBeVisible();
    const lifted = await write(owner, `students/${studentId}/status`, { status: 'active', reason: 'فك الإيقاف للتعويض',
      status_revision: suspended.body.status_revision, request_id: crypto.randomUUID() });
    expect(lifted.status).toBe(200);
    backdate(centerId, `UPDATE student_suspensions SET lifted_at = now() - interval '2 days' WHERE student_id = '${studentId}' AND lifted_at IS NOT NULL`);
    const sourceRoster = await owner.request.get(`${origin}/api/v1/center/groups/${source.id}/sessions/${sourceId}/attendance`);
    expect(Number(sourceRoster.headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    expect((await sourceRoster.json()).students[0]).toMatchObject({ attempt_id: attemptId, status: null });
    const stillMissing = await owner.request.get(`${origin}/api/v1/center/${coveragePath}`);
    expect((await stillMissing.json()).students[0]).toMatchObject({ covered_count: 0, missing_numbers: [1] });
    const booked = await write(owner, `students/${studentId}/enrollments/${attemptId}/makeup/book`, {
      session_id: targetId, source_session_id: null, attempt_revision: enrolled.body.attempt.revision,
      session_revision: targetSession.body.sessions[0].revision, request_id: crypto.randomUUID(),
    });
    expect(booked.status).toBe(201);
    expect((await (await owner.request.get(`${origin}/api/v1/center/${coveragePath}`)).json()).students[0].covered_count).toBe(0);
    expect((await write(owner, `groups/${target.id}/start`, { revision: targetSession.body.group_revision })).status).toBe(200);
    backdate(centerId, `UPDATE study_groups SET started_at = now() - interval '2 days' WHERE id = '${target.id}';
      UPDATE study_sessions SET scheduled_at = now() - interval '1 hour' WHERE id = '${targetId}'`);
    const counted = await write(owner, `groups/${target.id}/sessions/${targetId}/attendance`, {
      attempt_id: attemptId, status: 'counted', revision: 1, request_id: crypto.randomUUID(),
    });
    expect(counted.status).toBe(201);
    expect((await write(owner, `groups/${target.id}/sessions/${targetId}/close`, {
      revision: 2, request_id: crypto.randomUUID(),
    })).status).toBe(200);
    const restored = await owner.request.get(`${origin}/api/v1/center/${coveragePath}`);
    expect(Number(restored.headers()['x-courses-query-count'])).toBeLessThanOrEqual(6);
    expect((await restored.json()).students[0]).toMatchObject({ covered_count: 1, required_count: 1, missing_numbers: [] });
    await owner.goto(coverageUrl);
    await owner.getByRole('checkbox', { name: `اختيار إتمام ${student.body.student.name}` }).check();
    await owner.locator('header.center-topbar').getByRole('button', { name: 'معاينة إكمال المجموعة' }).click();
    await expect(owner.getByRole('heading', { name: 'معاينة قرار الإتمام' })).toBeVisible();
    await expect(owner.getByText(/١ من ١/)).toBeVisible();
    await owner.locator('header.center-topbar').getByRole('button', { name: 'تأكيد الاعتماد' }).click();
    await expect(owner.getByText('اكتملت المجموعة، وحُفظت قرارات الطلاب المختارين.')).toBeVisible();
    const beforeCourse = logSize();
    await owner.goto(`${origin}/admin/${coursePath}`);
    await expect(owner.getByText('اكتمل الكورس دراسيًا')).toBeVisible();
    await assertPageQueries(coursePath, beforeCourse);
    await expect(owner.getByText(/النواقص وقت القرار: لا يوجد/)).toBeVisible();
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.locator('html').getAttribute('dir')).toBe('rtl');
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await owner.close(); }
});

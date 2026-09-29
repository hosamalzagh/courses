import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_THRESHOLD_CREDENTIALS || !process.env.COURSES_THRESHOLD_QUERY_LOG || !process.env.COURSES_THRESHOLD_DB_PORT,
  "Requires disposable PostgreSQL, protected browser credentials, and an SSR query log.");
const origin = process.env.COURSES_THRESHOLD_ORIGIN ?? "http://alpha.courses.test:8065";
const credentials = process.env.COURSES_THRESHOLD_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_THRESHOLD_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff" | "beta" = "alpha") {
  const host = who === "beta" ? origin.replace("alpha.", "beta.") : origin;
  await page.goto(`${host}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials[who].password);
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/v1/center/auth/login") && response.request().method() === "POST");
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), `Login returned ${JSON.stringify(await response.json())}`).toBe(200);
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, route: string, payload: object, method = "POST") {
  return page.evaluate(async ({ route, payload, method }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

test("selected existing attempts keep their threshold until reviewed and approved", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  const beta = await browser.newPage();
  try {
    await signIn(owner);
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const centerId = workspace.center.id as string;
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const course = await write(owner, "courses", { branch_id: north, name: `Threshold ${crypto.randomUUID().slice(0, 6)}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "مرحلة", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: "مستوى", request_id: crypto.randomUUID(),
      lectures: Array.from({ length: 10 }, (_, index) => ({ number: index + 1, content: `محتوى ${index + 1}`, planned_hours: 2 })) });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", { name: `محاضر ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: `مجموعة ${Date.now()}`, approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(group.status).toBe(201);
    const groupId = group.body.group.id as string;
    const student = await write(owner, "students", { name: `طالب النسبة ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const account = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/account`)).json();
    if (!account.account.currency) {
      expect((await write(owner, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
    }
    const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/enrollments`)).json();
    const saved = await write(owner, `students/${student.body.student.id}/enrollments`, {
      group_id: groupId, group_revision: group.body.group.revision, currency_revision: enrollment.student.currency_revision,
      joined_on: new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" }), discount: "0.00", discount_reason: null,
      version: enrollment.student.version, request_id: crypto.randomUUID(),
    });
    expect(saved.status).toBe(201);
    const completedStudent = await write(owner, "students", { name: `طالب مكتمل ${Date.now()}`,
      branch_ids: [north], request_id: crypto.randomUUID() });
    expect(completedStudent.status).toBe(201);
    const completedEnrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${completedStudent.body.student.id}/enrollments`)).json();
    const completedAttempt = await write(owner, `students/${completedStudent.body.student.id}/enrollments`, {
      group_id: groupId, group_revision: group.body.group.revision,
      currency_revision: completedEnrollment.student.currency_revision,
      joined_on: new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" }),
      discount: "0.00", discount_reason: null, version: completedEnrollment.student.version,
      request_id: crypto.randomUUID(),
    });
    expect(completedAttempt.status).toBe(201);
    const settings = await write(owner, `groups/${groupId}/settings`, {
      revision: group.body.group.revision, approved_price: "0.00", completion_threshold: 60,
      instructor_ids: [instructor.body.instructor.id],
    }, "PATCH");
    expect(settings.status).toBe(200);
    const attemptId = saved.body.attempt.id as string;
    const completedAttemptId = completedAttempt.body.attempt.id as string;
    const planId = level.body.level.plan.id as string;
    for (const id of [centerId, groupId, attemptId, completedAttemptId, planId]) expect(id).toMatch(/^[a-f0-9-]{36}$/);
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_THRESHOLD_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-v", "ON_ERROR_STOP=1", "-c", `
INSERT INTO study_sessions (id, group_id, plan_lecture_id, number, scheduled_at, status, revision, created_by, created_by_name, created_at, updated_at)
SELECT gen_random_uuid(), '${groupId}', lectures.id, lectures.number, now() + lectures.number * interval '1 hour', 'planned', 1,
  (SELECT user_id FROM center_grants WHERE role = 'center_owner' LIMIT 1), 'اختبار المتصفح', now(), now()
FROM plan_lectures AS lectures WHERE lectures.plan_version_id = '${planId}' ORDER BY lectures.number LIMIT 6;
INSERT INTO study_attendance_entries (id, session_id, attempt_id, status, revision, recorded_by, recorded_at, created_at, updated_at)
SELECT gen_random_uuid(), sessions.id, '${attemptId}', 'counted', 1,
  (SELECT user_id FROM center_grants WHERE role = 'center_owner' LIMIT 1), now(), now(), now()
FROM study_sessions AS sessions WHERE sessions.group_id = '${groupId}';`], { stdio: "ignore" });
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_THRESHOLD_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-v", "ON_ERROR_STOP=1", "-c",
      `UPDATE study_attempts SET status = 'completed' WHERE id = '${completedAttemptId}'`], { stdio: "ignore" });

    const url = `${origin}/admin/groups/${groupId}/coverage`;
    const log = process.env.COURSES_THRESHOLD_QUERY_LOG!;
    const before = readFileSync(log, "utf8").trim().split("\n").length;
    const html = await (await owner.request.get(url)).text();
    expect(html).toContain(student.body.student.name);
    const reads = readFileSync(log, "utf8").trim().split("\n").slice(before)
      .map(line => JSON.parse(line) as { path: string; count: number | null })
      .filter(read => read.path === `/api/v1/center/groups/${groupId}/coverage`);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(read => Number.isInteger(read.count) && read.count! <= 6)).toBe(true);

    await owner.goto(url);
    await expect(owner.getByText("حد هذه المحاولة: ٨٠%", { exact: false }).first()).toBeVisible();
    await expect(owner.getByRole("checkbox", { name: `اختيار تسجيل ${completedStudent.body.student.name} لتطبيق نسبة الإتمام` })).toBeDisabled();
    await owner.getByRole("checkbox", { name: `اختيار تسجيل ${student.body.student.name} لتطبيق نسبة الإتمام` }).check();
    await owner.getByRole("textbox", { name: "سبب التطبيق" }).fill("قرار أكاديمي موثق بعد مراجعة نسبة المجموعة");
    await owner.getByRole("searchbox", { name: "بحث في تقرير أهلية إتمام الدراسة" }).fill("بحث آخر");
    await owner.getByRole("button", { name: "بحث في جميع تقرير أهلية إتمام الدراسة" }).click();
    await expect(owner.getByRole("alertdialog", { name: "مغادرة دون تطبيق" })).toBeVisible();
    await owner.getByRole("button", { name: "إلغاء" }).click();
    await expect(owner.getByRole("checkbox", { name: `اختيار تسجيل ${student.body.student.name} لتطبيق نسبة الإتمام` })).toBeChecked();
    await expect(owner.getByRole("textbox", { name: "سبب التطبيق" })).toHaveValue("قرار أكاديمي موثق بعد مراجعة نسبة المجموعة");
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة أثر النسبة" }).click();
    await expect(owner.getByText(/٨٠٪ \(٨ محاضرات\) ← ٦٠٪ \(٦ محاضرات\)/)).toBeVisible();
    await expect(owner.getByText(/الأهلية غير مستوفٍ ← مستوفٍ مبدئيًا/)).toBeVisible();
    await expect(owner.getByText(/يتضمن الرصيد ٦ محاضرة مفتوحة/)).toBeVisible();
    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>(resolve => { releaseApproval = resolve; });
    await owner.route(`**/api/v1/center/groups/${groupId}/completion-threshold`, async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      const response = await route.fetch();
      await approvalGate;
      await route.fulfill({ response });
    });
    await owner.locator("header.center-topbar").getByRole("button", { name: "اعتماد التطبيق على المختارين" }).click();
    await expect(owner.locator('header.center-topbar button[aria-busy="true"]').last()).toBeVisible();
    await expect(owner.getByRole("textbox", { name: "سبب التطبيق" })).toBeDisabled();
    await owner.locator("header.center-topbar").getByRole("link", { name: "جدول محاضرات المجموعة" }).click();
    await expect(owner.getByRole("alertdialog", { name: "انتظر نتيجة اعتماد النسبة" })).toBeVisible();
    await owner.getByRole("button", { name: "العودة للتحقق" }).click();
    releaseApproval();
    await expect(owner.getByText("تم تطبيق نسبة الإتمام على التسجيلات المختارة وحفظ قرارها في سجل التدقيق.")).toBeVisible();
    await expect(owner.getByText("حد هذه المحاولة: ٦٠%", { exact: false })).toBeVisible();
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByRole("heading", { name: "تطبيق نسبة الإتمام على تسجيلات قائمة" }).first()).toBeVisible();
    const auditDecision = owner.getByText("عرض قرار تطبيق نسبة الإتمام").first().locator("..");
    await auditDecision.locator("summary").click();
    await expect(auditDecision.getByText(/الأهلية غير مستوفٍ ← مستوفٍ مبدئيًا/)).toBeVisible();
    await expect(auditDecision.getByText(/يتضمن الرصيد وقت القرار ٦ محاضرة مفتوحة/)).toBeVisible();

    await signIn(staff, "staff");
    await staff.goto(url);
    await expect(staff.getByText(student.body.student.name)).toBeVisible();
    await expect(staff.getByRole("button", { name: "معاينة أثر النسبة" })).toHaveCount(0);
    expect((await write(staff, `groups/${groupId}/completion-threshold/preview`, {
      attempt_ids: [saved.body.attempt.id], reason: "محاولة بلا صلاحية",
    })).status).toBe(403);
    await signIn(beta, "beta");
    expect((await write(beta, `groups/${groupId}/completion-threshold/preview`, {
      attempt_ids: [saved.body.attempt.id], reason: "محاولة خارج المركز",
    })).status).toBe(404);
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(url);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await owner.close(); await staff.close(); await beta.close(); }
});

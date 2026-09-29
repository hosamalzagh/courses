import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

test.skip(!process.env.COURSES_PHASE3_CREDENTIALS || !process.env.COURSES_PHASE3_QUERY_LOG,
  "Requires the isolated Phase 3 PostgreSQL fixture and its SSR query log.");
test.setTimeout(180_000);

const origin = process.env.COURSES_PHASE3_ORIGIN ?? "http://alpha.courses.test:8054";
const queryLog = process.env.COURSES_PHASE3_QUERY_LOG ?? "";
const credentials = process.env.COURSES_PHASE3_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_PHASE3_CREDENTIALS, "utf8")) : {};

type QueryRow = { host: string; path: string; status: number; count: number | null };
const measurements: { kind: "api" | "page"; route: string; queries: number }[] = [];

test.afterAll(() => {
  const folder = path.resolve(process.cwd(), "test-results");
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "phase3-local-acceptance.json"), JSON.stringify({
    measured_at: new Date().toISOString(),
    measurements,
  }, null, 2));
});

function logRows(): QueryRow[] {
  return existsSync(queryLog) ? readFileSync(queryLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

async function signIn(page: Page, who: "alpha" | "beta" | "staff") {
  const host = who === "beta" ? origin.replace("alpha.", "beta.") : origin;
  await page.goto(`${host}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials[who].password);
  const response = page.waitForResponse(item => item.url().endsWith("/api/v1/center/auth/login") && item.request().method() === "POST");
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  const result = await response;
  expect(result.status(), JSON.stringify(await result.json())).toBe(200);
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

async function read(page: Page, route: string) {
  const response = await page.request.get(`${origin}/api/v1/center/${route}`);
  const raw = response.headers()["x-courses-query-count"];
  expect(raw, `Missing SQL count for ${route}`).toMatch(/^\d+$/);
  expect(Number(raw), route).toBeLessThanOrEqual(6);
  measurements.push({ kind: "api", route, queries: Number(raw) });
  return { status: response.status(), body: await response.json() };
}

async function measurePage(page: Page, route: string, expected: string) {
  const before = logRows().length;
  const response = await page.goto(`${origin}/admin/${route}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByText(expected, { exact: false }).first()).toBeVisible();
  const rows = logRows().slice(before).filter(row => row.host?.startsWith("alpha.courses.test") && row.path.startsWith("/api/v1/center/"));
  expect(rows.length, `No SSR API reads for ${route}`).toBeGreaterThan(0);
  expect(rows.every(row => row.status === 200 && Number.isInteger(row.count)), `Missing SQL counts for ${route}`).toBe(true);
  const total = rows.reduce((sum, row) => sum + row.count!, 0);
  expect(total, `Whole page SQL budget for ${route}`).toBeLessThanOrEqual(6);
  measurements.push({ kind: "page", route, queries: total });
  return total;
}

function cairoDate(offset = 0): string {
  return new Date(Date.now() + offset * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
}

function backdate(centerId: string, sql: string) {
  execFileSync("psql", ["-h", "127.0.0.1", "-p", "5554", "-U", "postgres", "-d", `courses_center_${centerId}`,
    "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "pipe" });
}

test("one student's academic, finance, permission and tenant history stays linked", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  const beta = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const workspace = (await read(owner, "student-workspace")).body;
    const centerId = workspace.center.id as string;
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south").id as number;
    expect((await write(owner, `members/${credentials.staff.membership_id}/grants`, {
      center_roles: [], branch_roles: { [north]: ["registration"] },
    }, "PUT")).status).toBe(200);
    await signIn(staff, "staff");
    await signIn(beta, "beta");
    const label = `رحلة قبول ${crypto.randomUUID().slice(0, 6)}`;

    const course = await write(owner, "courses", { branch_id: north, name: label, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "مرحلة القبول", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: "مستوى القبول", request_id: crypto.randomUUID(),
      lectures: [1, 2].map(number => ({ number, content: `محتوى ${number}`, planned_hours: 1 })) });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", { name: `محاضر ${label}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const createGroup = async (name: string) => {
      const response = await write(owner, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
        name, approved_price: "200.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
      expect(response.status).toBe(201);
      return response.body.group;
    };
    const firstGroup = await createGroup(`مجموعة أولى ${label}`);
    const secondGroup = await createGroup(`مجموعة ثانية ${label}`);
    const student = await write(owner, "students", { name: `طالب ${label}`, branch_ids: [north, south], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const studentId = student.body.student.id as string;
    const account = (await read(owner, `students/${studentId}/account`)).body;
    if (!account.account.currency) {
      expect((await write(owner, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
    }

    // A payment before registration remains available credit until staff explicitly allocate it.
    const firstAccount = (await read(owner, `students/${studentId}/account`)).body;
    const payment = await write(owner, `students/${studentId}/payments`, { branch_id: north, method: "cash",
      received_on: cairoDate(), amount: "100.00", version: firstAccount.account.version, request_id: crypto.randomUUID() });
    expect(payment.status).toBe(201);
    await measurePage(owner, `students/${studentId}/account`, "100.00 EGP");
    await measurePage(owner, `students/${studentId}/enrollments`, student.body.student.name);
    await owner.getByRole("searchbox", { name: "بحث في المجموعات المتاحة للتسجيل" }).fill(firstGroup.name);
    await owner.getByRole("button", { name: "بحث في جميع المجموعات المتاحة للتسجيل" }).click();
    await owner.getByRole("combobox", { name: "المجموعة الأساسية" }).selectOption(firstGroup.id);
    await owner.getByRole("button", { name: "تسجيل الطالب والرسوم" }).click();
    await owner.getByLabel("تاريخ الانضمام الفعلي").fill(cairoDate());
    await owner.getByRole("button", { name: "تسجيل الطالب والرسوم" }).click();
    await expect(owner.getByText("سُجلت المحاولة ورسومها معًا", { exact: false })).toBeVisible();
    const attempts = (await read(owner, `students/${studentId}/enrollments`)).body.attempts;
    expect(attempts).toHaveLength(1);
    const attemptId = attempts[0].id as string;
    expect(attempts[0].fee.net_amount).toBe("200.00");
    const allocationOptions = (await read(owner, `students/${studentId}/payments/${payment.body.payment.id}/allocation-options`)).body;
    const allocated = await write(owner, `students/${studentId}/payments/${payment.body.payment.id}/allocations`, {
      targets: [{ attempt_id: attemptId, amount: "100.00" }], version: allocationOptions.version, request_id: crypto.randomUUID(),
    });
    expect(allocated.status).toBe(201);
    expect((await read(owner, `students/${studentId}/account`)).body.account).toMatchObject({
      received_total: "100.00", allocated_total: "100.00", available_balance: "0.00", debt: "100.00",
    });
    // Another center cannot dereference the student's stable ID, and a north-only employee cannot read its south finance.
    expect((await beta.request.get(`${origin.replace("alpha.", "beta.")}/api/v1/center/students/${studentId}`)).status()).toBe(404);
    expect((await beta.request.get(`${origin.replace("alpha.", "beta.")}/api/v1/center/students/${studentId}/account`)).status()).toBe(404);
    expect((await staff.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).status()).toBe(404);
    const southOnly = await write(owner, "students", { name: `طالب الجنوب ${label}`, branch_ids: [south], request_id: crypto.randomUUID() });
    expect(southOnly.status).toBe(201);
    expect((await staff.request.get(`${origin}/api/v1/center/students/${southOnly.body.student.id}`)).status()).toBe(404);

    await owner.goto(`${origin}/admin/students/${studentId}/enrollments`);
    await owner.locator(`[id$="-waitlist-${attemptId}"]`).click();
    await owner.getByLabel("تاريخ بداية الانتظار").fill(cairoDate());
    await owner.getByLabel("سبب الانتظار").fill("تغيير وقت الدراسة");
    await owner.getByRole("button", { name: "نقل إلى الانتظار", exact: true }).first().click();
    await owner.getByRole("button", { name: "تأكيد الانتظار" }).click();
    await expect(owner.getByText(`انتظار منذ ${cairoDate()}`)).toBeVisible();
    const waiting = (await read(owner, `students/${studentId}/enrollments`)).body.attempts[0];
    expect(waiting.current_group_id).toBeNull();
    expect(waiting.fee.net_amount).toBe("200.00");
    await owner.locator(`[id$="-waitlist-${attemptId}"]`).click();
    await owner.getByRole("combobox", { name: "المجموعة الجديدة" }).selectOption(secondGroup.id);
    await owner.getByLabel("تاريخ الإلحاق الفعلي").fill(cairoDate());
    await owner.getByRole("button", { name: "إعادة الإلحاق", exact: true }).first().click();
    await owner.getByRole("button", { name: "تأكيد الإلحاق" }).click();
    await expect(owner.getByRole("table", { name: "محاولات الدراسة" }).getByRole("row", { name: new RegExp(secondGroup.name) })).toBeVisible();
    const reattached = (await read(owner, `students/${studentId}/enrollments`)).body.attempts[0];
    expect(reattached).toMatchObject({ id: attemptId, current_group_id: secondGroup.id, fee: { net_amount: "200.00" } });
    expect((await read(owner, `students/${studentId}/account`)).body.account).toMatchObject({
      received_total: "100.00", allocated_total: "100.00", available_balance: "0.00", debt: "100.00",
    });
    await measurePage(owner, `students/${studentId}?tab=study`, student.body.student.name);
    const studyTable = owner.getByRole("table", { name: "محاولات الدراسة" });
    await expect(studyTable.getByRole("row", { name: new RegExp(firstGroup.name) })).toContainText("انتقل من هذه المجموعة");
    await expect(studyTable.getByRole("row", { name: new RegExp(secondGroup.name) })).toContainText("يدرس المستوى");

    const scheduled = await write(owner, `groups/${secondGroup.id}/sessions`, {
      kind: "single", revision: secondGroup.revision, start_at: `${cairoDate(2)}T17:00`,
      plan_lecture_number: 1, request_id: crypto.randomUUID(),
    });
    expect(scheduled.status).toBe(201);
    const sessionId = scheduled.body.sessions[0].id as string;
    expect((await write(owner, `groups/${secondGroup.id}/start`, { revision: scheduled.body.group_revision })).status).toBe(200);
    backdate(centerId, `UPDATE study_groups SET started_at = now() - interval '2 days' WHERE id = '${secondGroup.id}';
      UPDATE study_sessions SET scheduled_at = now() - interval '1 hour' WHERE id = '${sessionId}'`);
    const attendancePath = `groups/${secondGroup.id}/sessions/${sessionId}/attendance`;
    await measurePage(owner, attendancePath, student.body.student.name);
    const attendanceRow = owner.getByRole("row", { name: new RegExp(student.body.student.name) });
    await attendanceRow.getByRole("button", { name: "تسجيل الحضور" }).click();
    await owner.getByRole("button", { name: "حاضر محتسب" }).click();
    await expect(attendanceRow).toContainText("حاضر محتسب");
    await owner.getByRole("button", { name: "إغلاق كشف المحاضرة" }).click();
    await owner.getByRole("button", { name: "تأكيد الإغلاق" }).click();
    await owner.waitForLoadState("networkidle");
    await measurePage(owner, `groups/${secondGroup.id}/coverage`, student.body.student.name);
    const coverage = (await read(owner, `groups/${secondGroup.id}/coverage`)).body;
    expect(coverage.students.find((row: { attempt_id: string }) => row.attempt_id === attemptId)).toMatchObject({
      covered_count: 1, required_count: 2, missing_numbers: [2],
    });

    await owner.setViewportSize({ width: 390, height: 844 });
    await measurePage(owner, `students/${studentId}/enrollments`, student.body.student.name);
    expect(await owner.locator("html").getAttribute("dir")).toBe("rtl");
    await owner.getByRole("button", { name: "القائمة" }).click();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.getByRole("button", { name: "إغلاق القائمة" }).click();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("نقل الطالب إلى انتظار المستوى").first()).toBeVisible();
    await expect(owner.getByText("إعادة إلحاق الطالب بالمحاولة نفسها").first()).toBeVisible();
  } finally {
    await Promise.all([owner.close(), staff.close(), beta.close()]);
  }
});

test("student register stays paged and keeps the SQL budget on a longer dataset", async ({ browser }) => {
  const owner = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const workspace = (await read(owner, "student-workspace")).body;
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const stamp = crypto.randomUUID().slice(0, 8);
    const before = await measurePage(owner, "students", "ملفات الطلاب");
    for (let index = 0; index < 55; index++) {
      const saved = await write(owner, "students", { name: `قياس القائمة ${stamp} ${index}`,
        branch_ids: [north], request_id: crypto.randomUUID() });
      expect(saved.status).toBe(201);
    }
    const firstPage = (await read(owner, "student-workspace?page=1")).body;
    expect(firstPage.pagination.has_more).toBe(true);
    expect(firstPage.students).toHaveLength(50);
    const cold = await measurePage(owner, "students", "ملفات الطلاب");
    const warm = await measurePage(owner, "students", "ملفات الطلاب");
    const secondPage = (await read(owner, "student-workspace?page=2")).body;
    expect(secondPage.students.length).toBeGreaterThan(0);
    expect(secondPage.students.length).toBeLessThanOrEqual(50);
    await measurePage(owner, "students?page=2", "ملفات الطلاب");
    expect([before, cold, warm].every(count => count > 0 && count <= 6)).toBe(true);
  } finally {
    await owner.close();
  }
});

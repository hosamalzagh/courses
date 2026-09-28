import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_NOTES_CREDENTIALS || !process.env.COURSES_NOTES_DB_PORT || !process.env.COURSES_NOTES_QUERY_LOG,
  "Requires the disposable attendance-note center and SSR query log.");
test.setTimeout(60_000);
const origin = process.env.COURSES_NOTES_ORIGIN ?? "http://alpha.courses.test:8658";
const credentials = process.env.COURSES_NOTES_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_NOTES_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff") {
  await page.goto(`${origin}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials[who].password);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, route: string, payload: object, method = "POST") {
  return page.evaluate(async ({ route, payload, method }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json",
        "X-XSRF-TOKEN": decodeURIComponent(token ?? "") }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

test("attendance and closed absence notes keep versions, importance and event permissions", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const branch = await write(owner, "branches", { name: `ملاحظات ${Date.now()}`, slug: `notes-${Date.now()}` });
    expect(branch.status).toBe(201);
    const branchId = branch.body.branch.id as number;
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const centerId = workspace.center.id as string;
    const course = await write(owner, "courses", { branch_id: branchId, name: "كورس ملاحظات الحضور", request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "مرحلة", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: "مستوى", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "محاضرة كاملة", planned_hours: 1 }] });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", { name: "محاضر الملاحظات", branch_ids: [branchId], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: "مجموعة الملاحظات", approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(group.status).toBe(201);
    const groupId = group.body.group.id as string;
    const start = new Date(Date.now() + 14 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
    const saved = await write(owner, `groups/${groupId}/sessions`, { kind: "single", revision: 1,
      start_at: start, plan_lecture_number: 1, request_id: crypto.randomUUID() });
    expect(saved.status).toBe(201);
    const sessionId = saved.body.sessions[0].id as string;
    const groupRevision = saved.body.group_revision as number;
    const students: { id: string; name: string; attemptId: string }[] = [];
    for (let index = 0; index < 2; index++) {
      const name = `${index ? "غائب" : "حاضر"} ${Date.now()}`;
      const created = await write(owner, "students", { name, branch_ids: [branchId], request_id: crypto.randomUUID() });
      expect(created.status).toBe(201);
      const studentId = created.body.student.id as string;
      const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
      if (!enrollment.student.currency_revision) throw new Error("Missing currency revision");
      if (!enrollment.student.currency) {
        const currency = await write(owner, "financial-currency", { currency: "EGP", revision: enrollment.student.currency_revision }, "PATCH");
        expect([200, 409]).toContain(currency.status);
      }
      const current = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
      const joinedOn = new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
      const attempt = await write(owner, `students/${studentId}/enrollments`, { group_id: groupId, group_revision: groupRevision,
        currency_revision: current.student.currency_revision, joined_on: joinedOn,
        discount: "0.00", discount_reason: null, version: current.student.version, request_id: crypto.randomUUID() });
      expect(attempt.status).toBe(201);
      students.push({ id: studentId, name, attemptId: attempt.body.attempt.id });
    }
    const started = await write(owner, `groups/${groupId}/start`, { revision: groupRevision });
    expect(started.status).toBe(200);
    expect(centerId).toMatch(/^[a-f0-9-]{36}$/);
    const tenantDb = `courses_center_${centerId}`;
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_NOTES_DB_PORT!, "-U", "postgres", "-d", tenantDb,
      "-c", `UPDATE study_groups SET started_at = now() - interval '1 day' WHERE id = '${groupId}'; UPDATE study_sessions SET scheduled_at = now() - interval '1 hour' WHERE id = '${sessionId}'`], { stdio: "ignore" });

    const path = `groups/${groupId}/sessions/${sessionId}/attendance`;
    const url = `${origin}/admin/${path}`;
    const beforeLog = readFileSync(process.env.COURSES_NOTES_QUERY_LOG!, "utf8").trim().split("\n").length;
    await owner.goto(url);
    await expect(owner.getByRole("row", { name: new RegExp(students[0].name) })).toBeVisible();
    const reads = readFileSync(process.env.COURSES_NOTES_QUERY_LOG!, "utf8").trim().split("\n").slice(beforeLog)
      .map(line => JSON.parse(line) as { path: string; count: number | null })
      .filter(read => read.path.startsWith("/api/v1/center/"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.some(read => read.path.startsWith(`/api/v1/center/${path}`))).toBe(true);
    expect(reads.every(read => Number.isInteger(read.count) && read.count! >= 0)).toBe(true);
    expect(reads.reduce((total, read) => total + read.count!, 0)).toBeLessThanOrEqual(6);
    const presentRow = owner.getByRole("row", { name: new RegExp(students[0].name) });
    await presentRow.getByRole("button", { name: "تسجيل الحضور" }).click();
    await owner.getByRole("button", { name: "حاضر محتسب" }).click();
    await expect(presentRow).toContainText("حاضر محتسب");
    const recordedBeforeNote = await (await owner.request.get(`${origin}/api/v1/center/${path}`)).json();
    await presentRow.getByRole("button", { name: "إضافة ملاحظة" }).click();
    await expect(owner.getByRole("heading", { name: new RegExp(`ملاحظة حضور ${students[0].name}`) })).toBeFocused();
    await owner.getByRole("textbox", { name: "نص الملاحظة" }).fill("حضر مع مراجعة الواجب");
    await owner.getByRole("button", { name: "إضافة الملاحظة" }).click();
    await expect(presentRow).toContainText("حضر مع مراجعة الواجب");
    await owner.getByRole("checkbox", { name: "ملاحظة مهمة" }).click();
    await owner.getByRole("button", { name: "حفظ تعديل الملاحظة" }).click();
    await expect(presentRow).toContainText("★");
    await owner.getByRole("checkbox", { name: "ملاحظة مهمة" }).click();
    await owner.getByRole("button", { name: "حفظ تعديل الملاحظة" }).click();
    await expect(presentRow).not.toContainText("★");
    await expect(owner.getByRole("heading", { name: "تاريخ التعديل" })).toBeVisible();
    await expect(owner.getByText("نسخة ٣")).toBeVisible();
    if (process.env.COURSES_NOTES_SCREENSHOTS) await owner.screenshot({ path: "test-results/issue76-desktop.png", fullPage: true });
    const entryId = (await (await owner.request.get(`${origin}/api/v1/center/${path}`)).json()).students
      .find((row: { student_id: string }) => row.student_id === students[0].id).entry_id as string;
    const history = await owner.request.get(`${origin}/api/v1/center/${path}/${entryId}/note`);
    expect(Number(history.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    expect((await history.json()).versions).toHaveLength(3);
    const recordedAfterNote = await (await owner.request.get(`${origin}/api/v1/center/${path}`)).json();
    expect(recordedAfterNote.session.revision).toBe(recordedBeforeNote.session.revision);
    expect(recordedAfterNote.students.find((row: { entry_id: string }) => row.entry_id === entryId).entry_revision)
      .toBe(recordedBeforeNote.students.find((row: { entry_id: string }) => row.entry_id === entryId).entry_revision);
    await owner.getByRole("button", { name: "إلغاء", exact: true }).click();
    await expect(presentRow.getByRole("button", { name: "عرض الملاحظة" })).toBeFocused();
    let failInitialNoteRead = true;
    await owner.route(new RegExp(`/api/v1/center/${path}/[^/?]+/note$`), async route => {
      if (failInitialNoteRead && route.request().method() === "GET") {
        failInitialNoteRead = false;
        await route.abort();
      } else await route.continue();
    });
    await presentRow.getByRole("button", { name: "عرض الملاحظة" }).click();
    await expect(owner.getByText("تعذر تحميل الملاحظة ونسخها.")).toBeVisible();
    await owner.getByRole("button", { name: "إعادة المحاولة" }).click();
    await expect(owner.getByRole("textbox", { name: "نص الملاحظة" })).toHaveValue("حضر مع مراجعة الواجب");
    await owner.getByRole("button", { name: "إلغاء", exact: true }).click();
    await presentRow.getByRole("button", { name: "عرض الملاحظة" }).click();
    await owner.getByRole("searchbox", { name: "بحث في كشف الطلاب المستحقين" }).fill(students[1].name);
    await owner.getByRole("button", { name: "بحث في جميع كشف الطلاب المستحقين" }).click();
    await expect(owner).toHaveURL(/\?q=/);
    await expect(owner.getByRole("heading", { name: new RegExp(`ملاحظة حضور ${students[0].name}`) })).toHaveCount(0);
    await owner.getByRole("button", { name: "مسح البحث في كشف الطلاب المستحقين" }).click();
    await expect(owner).toHaveURL(url);
    await owner.getByRole("button", { name: "إغلاق كشف المحاضرة" }).click();
    await owner.getByRole("button", { name: "تأكيد الإغلاق" }).click();
    const absentRow = owner.getByRole("row", { name: new RegExp(students[1].name) });
    await expect(absentRow).toContainText("غائب");
    await absentRow.getByRole("button", { name: "إضافة ملاحظة" }).click();
    await owner.getByRole("textbox", { name: "نص الملاحظة" }).fill("غاب بعد إغلاق الكشف");
    await owner.getByRole("button", { name: "إضافة الملاحظة" }).click();
    await expect(absentRow).toContainText("غاب بعد إغلاق الكشف");
    const closedAfterNote = await (await owner.request.get(`${origin}/api/v1/center/${path}`)).json();
    expect(closedAfterNote.session.closed_at).toBeTruthy();
    expect(closedAfterNote.students.find((row: { student_id: string }) => row.student_id === students[1].id).status).toBe("absent");
    await owner.getByRole("button", { name: "إلغاء", exact: true }).click();
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.getByRole("button", { name: "القائمة" }).click();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.getByRole("button", { name: "إغلاق القائمة" }).click();
    await expect(owner.getByRole("dialog", { name: "مركز قبول الحضور" })).toHaveCount(0);
    await expect(owner.getByRole("row", { name: new RegExp(students[1].name) })).toBeVisible();
    if (process.env.COURSES_NOTES_SCREENSHOTS) await owner.screenshot({ path: "test-results/issue76-mobile-dark.png", fullPage: true });
    const members = await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json();
    const membershipId = members.members.find((member: { user: { email: string } }) => member.user.email === credentials.staff.email)?.id;
    expect(membershipId).toBeTruthy();
    expect((await write(owner, `members/${membershipId}/grants`, { center_roles: [], branch_roles: { [branchId]: ["attendance"] } }, "PUT")).status).toBe(200);
    await signIn(staff, "staff");
    await staff.goto(url);
    await expect(staff.getByText("غاب بعد إغلاق الكشف")).toBeVisible();
    expect((await write(owner, `members/${membershipId}/grants`, { center_roles: [], branch_roles: {} }, "PUT")).status).toBe(200);
    expect((await staff.request.get(`${origin}/api/v1/center/${path}/${entryId}/note`)).status()).toBe(404);
    expect((await write(staff, `${path}/${entryId}/note`, { body: "بعد سحب المنحة", important: true,
      revision: 3, entry_revision: recordedAfterNote.students.find((row: { entry_id: string }) => row.entry_id === entryId).entry_revision,
      request_id: crypto.randomUUID() }, "PUT")).status).toBe(404);
    await staff.reload();
    await expect(staff.getByText("حضر مع مراجعة الواجب")).toHaveCount(0);
  } finally {
    await owner.close(); await staff.close();
  }
});

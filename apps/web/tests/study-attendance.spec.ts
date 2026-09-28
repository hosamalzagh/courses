import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_ATTENDANCE_CREDENTIALS || !process.env.COURSES_ATTENDANCE_DB_PORT,
  "Requires a disposable PostgreSQL center and browser credentials.");
const origin = process.env.COURSES_ATTENDANCE_ORIGIN ?? "http://alpha.courses.test:8057";
const credentials = process.env.COURSES_ATTENDANCE_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_ATTENDANCE_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff" = "alpha") {
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
      method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

function cairoDate(dayOffset = 0) {
  return new Date(Date.now() + dayOffset * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
}

test("records whole-session attendance, undoes the last entry, closes absences, and denies restricted staff", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const branchId = workspace.branches[0].id;
    const centerId = workspace.center.id as string;
    const course = await write(owner, "courses", { branch_id: branchId, name: `Attendance ${crypto.randomUUID().slice(0, 6)}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "Whole lecture", planned_hours: 2 }] });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", { name: `Teacher ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: `Group ${crypto.randomUUID().slice(0, 6)}`, approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(group.status).toBe(201);
    const groupId = group.body.group.id as string;
    const start = new Date(Date.now() + 14 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
    const savedSession = await write(owner, `groups/${groupId}/sessions`, { kind: "single", revision: 1,
      start_at: start, plan_lecture_number: 1, request_id: crypto.randomUUID() });
    expect(savedSession.status).toBe(201);
    const sessionId = savedSession.body.sessions[0].id as string;
    const groupRevision = savedSession.body.group_revision as number;
    const students: { id: string; name: string; attemptId: string }[] = [];
    for (const [index, joinedOn] of [cairoDate(), cairoDate(), cairoDate(1)].entries()) {
      const name = `حضور ${index} ${Date.now()}`;
      const created = await write(owner, "students", { name, branch_ids: [branchId], request_id: crypto.randomUUID() });
      expect(created.status).toBe(201);
      const studentId = created.body.student.id as string;
      if (index === 0) {
        const account = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
        if (!account.account.currency) {
          expect((await write(owner, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
        }
      }
      const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
      const saved = await write(owner, `students/${studentId}/enrollments`, { group_id: groupId, group_revision: groupRevision,
        currency_revision: enrollment.student.currency_revision, joined_on: joinedOn, discount: "0.00", discount_reason: null,
        version: enrollment.student.version, request_id: crypto.randomUUID() });
      expect(saved.status).toBe(201);
      students.push({ id: studentId, name, attemptId: saved.body.attempt.id });
    }
    const tenantDb = `courses_center_${centerId}`;
    expect(centerId).toMatch(/^[a-f0-9-]{36}$/);
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_ATTENDANCE_DB_PORT!, "-U", "postgres", "-d", tenantDb,
      "-c", `UPDATE study_sessions SET scheduled_at = now() - interval '1 hour' WHERE id = '${sessionId}'`], { stdio: "ignore" });

    const path = `groups/${groupId}/sessions/${sessionId}/attendance`;
    const url = `${origin}/admin/${path}`;
    const response = await owner.request.get(`${origin}/api/v1/center/${path}`);
    expect(Number(response.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    expect((await response.json()).students).toHaveLength(2);
    const html = await (await owner.request.get(url)).text();
    expect(html).toContain(students[0].name);
    expect(html).toContain("غير مسجل");
    await owner.goto(`${origin}/admin/groups/${groupId}/sessions`);
    await owner.getByRole("link", { name: "كشف الحضور" }).click();
    await expect(owner).toHaveURL(url);
    const row = owner.getByRole("row", { name: new RegExp(students[0].name) });
    await row.getByRole("button", { name: "حاضر محتسب" }).click();
    await expect(row).toContainText("حاضر محتسب");
    await row.getByRole("button", { name: "تراجع عن آخر إدخال" }).click();
    await expect(row).toContainText("غير مسجل");
    await row.getByRole("button", { name: "حاضر غير محتسب" }).click();
    await expect(row).toContainText("حاضر غير محتسب");
    const recordedRoster = await (await owner.request.get(`${origin}/api/v1/center/${path}`)).json();
    const entryId = recordedRoster.students.find((item: { attempt_id: string }) => item.attempt_id === students[0].attemptId)?.entry_id;
    expect(entryId).toBeTruthy();

    const members = await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json();
    const membershipId = members.members.find((item: { user: { email: string } }) => item.user.email === credentials.staff.email)?.id;
    expect(membershipId).toBeTruthy();
    expect((await write(owner, `members/${membershipId}/grants`, { center_roles: [], branch_roles: { [branchId]: ["branch_viewer"] } }, "PUT")).status).toBe(200);
    await signIn(staff, "staff");
    await staff.goto(url);
    await expect(staff.getByText(students[0].name)).toBeVisible();
    await expect(staff.getByRole("button", { name: "إغلاق كشف المحاضرة" })).toHaveCount(0);
    expect((await write(staff, path, { attempt_id: students[1].attemptId, status: "counted", revision: 4,
      request_id: crypto.randomUUID() })).status).toBe(403);
    expect((await write(staff, `groups/${groupId}/sessions/${sessionId}/close`, { revision: 4,
      request_id: crypto.randomUUID() })).status).toBe(403);

    await owner.getByRole("button", { name: "إغلاق كشف المحاضرة" }).click();
    await owner.getByRole("button", { name: "تأكيد الإغلاق" }).click();
    await expect(owner.getByRole("row", { name: new RegExp(students[1].name) })).toContainText("غائب");
    expect(await owner.locator("body").innerText()).not.toContain(students[2].name);
    expect((await write(owner, `${path}/${entryId}/undo`, { revision: 5, request_id: crypto.randomUUID() })).status).toBe(409);
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.locator("html").getAttribute("dir")).toBe("rtl");
    await owner.getByRole("button", { name: "القائمة" }).click();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await owner.close(); await staff.close(); }
});

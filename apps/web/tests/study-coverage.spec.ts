import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_COVERAGE_CREDENTIALS || !process.env.COURSES_COVERAGE_DB_PORT || !process.env.COURSES_COVERAGE_QUERY_LOG,
  "Requires disposable PostgreSQL, protected browser credentials, and an SSR query log.");
const origin = process.env.COURSES_COVERAGE_ORIGIN ?? "http://alpha.courses.test:8059";
const credentials = process.env.COURSES_COVERAGE_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_COVERAGE_CREDENTIALS, "utf8")) : {};

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

test("coverage is provisional until closure and hidden branch data stays denied", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south").id as number;
    const centerId = workspace.center.id as string;
    const course = await write(owner, "courses", { branch_id: north, name: `Coverage ${crypto.randomUUID().slice(0, 6)}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "Whole lecture", planned_hours: 3 }] });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", { name: `Teacher ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: `Group ${crypto.randomUUID().slice(0, 6)}`, approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(group.status).toBe(201);
    const groupId = group.body.group.id as string;
    const student = await write(owner, "students", { name: `طالب تغطية ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const account = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/account`)).json();
    if (!account.account.currency) {
      expect((await write(owner, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
    }
    const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/enrollments`)).json();
    const joinedOn = new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
    const saved = await write(owner, `students/${student.body.student.id}/enrollments`, {
      group_id: groupId, group_revision: group.body.group.revision, currency_revision: enrollment.student.currency_revision,
      joined_on: joinedOn, discount: "0.00", discount_reason: null, version: enrollment.student.version,
      request_id: crypto.randomUUID(),
    });
    expect(saved.status).toBe(201);
    const secondStudent = await write(owner, "students", { name: `طالب متأخر ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(secondStudent.status).toBe(201);
    const secondEnrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${secondStudent.body.student.id}/enrollments`)).json();
    const secondSaved = await write(owner, `students/${secondStudent.body.student.id}/enrollments`, {
      group_id: groupId, group_revision: group.body.group.revision, currency_revision: secondEnrollment.student.currency_revision,
      joined_on: joinedOn, discount: "0.00", discount_reason: null, version: secondEnrollment.student.version,
      request_id: crypto.randomUUID(),
    });
    expect(secondSaved.status).toBe(201);
    const start = new Date(Date.now() + 14 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
    const scheduled = await write(owner, `groups/${groupId}/sessions`, { kind: "single", revision: 1,
      start_at: start, plan_lecture_number: 1, request_id: crypto.randomUUID() });
    expect(scheduled.status).toBe(201);
    const sessionId = scheduled.body.sessions[0].id as string;
    expect((await write(owner, `groups/${groupId}/start`, { revision: scheduled.body.group_revision })).status).toBe(200);
    expect(centerId).toMatch(/^[a-f0-9-]{36}$/);
    expect(groupId).toMatch(/^[a-f0-9-]{36}$/);
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_groups SET started_at = now() - interval '2 days' WHERE id = '${groupId}'; UPDATE study_sessions SET scheduled_at = now() - interval '1 hour' WHERE id = '${sessionId}'`], { stdio: "ignore" });

    const path = `groups/${groupId}/coverage`;
    const url = `${origin}/admin/${path}`;
    const beforeSsr = readFileSync(process.env.COURSES_COVERAGE_QUERY_LOG!, "utf8").trim().split("\n").length;
    const html = await (await owner.request.get(url)).text();
    expect(html).toContain(student.body.student.name);
    expect(html).toContain("الناقص");
    const reads = readFileSync(process.env.COURSES_COVERAGE_QUERY_LOG!, "utf8").trim().split("\n").slice(beforeSsr)
      .map(line => JSON.parse(line) as { path: string; count: number | null }).filter(read => read.path === `/api/v1/center/${path}`);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(read => Number.isInteger(read.count) && read.count! <= 6)).toBe(true);
    const coursePath = `students/${student.body.student.id}/courses/${course.body.course.id}/completion`;
    const courseUrl = `${origin}/admin/${coursePath}`;
    const beforeCourseSsr = readFileSync(process.env.COURSES_COVERAGE_QUERY_LOG!, "utf8").trim().split("\n").length;
    const courseHtml = await (await owner.request.get(courseUrl)).text();
    expect(courseHtml).toContain("الكورس لم يكتمل دراسيًا");
    const courseReads = readFileSync(process.env.COURSES_COVERAGE_QUERY_LOG!, "utf8").trim().split("\n").slice(beforeCourseSsr)
      .map(line => JSON.parse(line) as { path: string; count: number | null }).filter(read => read.path === `/api/v1/center/${coursePath}`);
    expect(courseReads.length).toBeGreaterThan(0);
    expect(courseReads.every(read => Number.isInteger(read.count) && read.count! <= 6)).toBe(true);
    await owner.goto(`${origin}/admin/groups/${groupId}/sessions`);
    await owner.locator("header.center-topbar").getByRole("link", { name: "تقرير تغطية المحتوى وأهلية الإتمام" }).click();
    await expect(owner).toHaveURL(url);
    await expect(owner.locator("header.center-topbar").getByRole("link", { name: "جدول محاضرات المجموعة" })).toBeVisible();
    await expect(owner.getByRole("row", { name: new RegExp(student.body.student.name) })).toContainText("٠/١");
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" }).click();
    await expect(owner.getByText(/محاضرات المجموعة المفتوحة/)).toBeVisible();
    await expect(owner.locator("header.center-topbar").getByRole("button", { name: "تأكيد الاعتماد" })).toBeDisabled();

    const attendance = `groups/${groupId}/sessions/${sessionId}/attendance`;
    const recorded = await write(owner, attendance, { attempt_id: saved.body.attempt.id, status: "counted", revision: 1,
      request_id: crypto.randomUUID() });
    expect(recorded.status).toBe(201);
    await owner.reload();
    await expect(owner.getByText("مؤهل مبدئيًا — حضور مفتوح")).toBeVisible();
    await expect(owner.getByText(/قد تتغير النسبة عند التراجع/)).toBeVisible();
    expect((await write(owner, `${attendance}/${recorded.body.entry.id}/undo`, { revision: 2,
      request_id: crypto.randomUUID() })).status).toBe(200);
    await owner.reload();
    await expect(owner.getByRole("row", { name: new RegExp(student.body.student.name) })).toContainText("٠/١");
    const finalRecorded = await write(owner, attendance, { attempt_id: saved.body.attempt.id, status: "counted", revision: 3,
      request_id: crypto.randomUUID() });
    expect(finalRecorded.status).toBe(201);
    expect((await write(owner, `groups/${groupId}/sessions/${sessionId}/close`, { revision: 4,
      request_id: crypto.randomUUID() })).status).toBe(200);
    await owner.reload();
    await expect(owner.getByText("بلغ الحد — يحتاج اعتمادًا صريحًا")).toBeVisible();
    await expect(owner.getByText("مؤهل مبدئيًا — حضور مفتوح")).toHaveCount(0);
    await owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` }).check();
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_attendance_entries SET status = 'not_counted' WHERE id = '${finalRecorded.body.entry.id}'`], { stdio: "ignore" });
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" }).click();
    await expect(owner.getByText(/تغيرت أهلية أحد الطلاب/)).toBeVisible();
    await expect(owner.getByLabel(`سبب إتمام ${student.body.student.name} دون الحد`)).toBeVisible();
    await expect(owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` })).toBeChecked();
    await owner.getByLabel(`سبب إتمام ${student.body.student.name} دون الحد`).fill("سبب استثنائي مؤقت");
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_attendance_entries SET status = 'counted' WHERE id = '${finalRecorded.body.entry.id}'`], { stdio: "ignore" });
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" }).click();
    await expect(owner.getByText(/امسح السبب الذي لم يعد مطلوبًا/)).toBeVisible();
    await expect(owner.getByLabel(`سبب إتمام ${student.body.student.name} دون الحد`)).toBeVisible();
    await expect(owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` })).toBeChecked();
    await owner.getByLabel(`سبب إتمام ${student.body.student.name} دون الحد`).fill("");
    await expect(owner.getByLabel(`سبب إتمام ${student.body.student.name} دون الحد`)).toHaveCount(0);
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" }).click();
    await expect(owner.getByRole("heading", { name: "معاينة قرار الإتمام" })).toBeFocused();
    await owner.locator("header.center-topbar").getByRole("button", { name: "إلغاء المعاينة" }).click();
    await expect(owner.getByRole("heading", { name: "معاينة قرار الإتمام" })).toHaveCount(0);
    await expect(owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` })).not.toBeChecked();
    await expect(owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" })).toBeFocused();
    await owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` }).check();
    await owner.getByRole("checkbox", { name: `اختيار إتمام ${secondStudent.body.student.name}` }).check();
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_attempts SET status = 'completed' WHERE id = '${secondSaved.body.attempt.id}'`], { stdio: "ignore" });
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" }).click();
    await expect(owner.getByText("تغيرت محاولة دراسة أحد الطلاب. حدّث التقرير ثم أعد الاختيار.")).toBeVisible();
    await expect(owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` })).toBeChecked();
    await expect(owner.getByRole("checkbox", { name: `اختيار إتمام ${secondStudent.body.student.name}` })).not.toBeChecked();
    await expect(owner.getByRole("checkbox", { name: `اختيار إتمام ${secondStudent.body.student.name}` })).toBeDisabled();
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_attempts SET status = 'active' WHERE id = '${secondSaved.body.attempt.id}'`], { stdio: "ignore" });
    await owner.reload();
    await owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` }).check();
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_groups SET status = 'completed', revision = revision + 1 WHERE id = '${groupId}'`], { stdio: "ignore" });
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" }).click();
    await expect(owner.getByText("تغيرت حالة المجموعة. حدّث التقرير ثم أعد المعاينة.")).toBeVisible();
    await expect(owner.locator("header.center-topbar").getByRole("button", { name: "معاينة اعتماد الطلاب" })).toBeVisible();
    await expect(owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` })).toBeChecked();
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_groups SET status = 'started', revision = revision + 1 WHERE id = '${groupId}'`], { stdio: "ignore" });
    await owner.reload();
    await owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` }).check();
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" }).click();
    await expect(owner.getByText("ستصبح المجموعة مكتملة.")).toBeVisible();
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_attendance_entries SET status = 'not_counted' WHERE id = '${finalRecorded.body.entry.id}'`], { stdio: "ignore" });
    await owner.locator("header.center-topbar").getByRole("button", { name: "تأكيد الاعتماد" }).click();
    await expect(owner.getByText(/تغيرت أهلية أحد الطلاب/)).toBeVisible();
    await expect(owner.getByRole("heading", { name: "معاينة قرار الإتمام" })).toHaveCount(0);
    await expect(owner.getByRole("checkbox", { name: `اختيار إتمام ${student.body.student.name}` })).toBeChecked();
    await expect(owner.getByLabel(`سبب إتمام ${student.body.student.name} دون الحد`)).toBeVisible();
    execFileSync("psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_COVERAGE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_attendance_entries SET status = 'counted' WHERE id = '${finalRecorded.body.entry.id}'`], { stdio: "ignore" });
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة إكمال المجموعة" }).click();
    await expect(owner.getByText("ستصبح المجموعة مكتملة.")).toBeVisible();
    await owner.locator("header.center-topbar").getByRole("button", { name: "تأكيد الاعتماد" }).click();
    await expect(owner.getByText("اكتملت المجموعة، وحُفظت قرارات الطلاب المختارين.")).toBeVisible();
    await owner.reload();
    await expect(owner.getByText("اكتمل بقرار محفوظ")).toBeVisible();
    await owner.getByRole("checkbox", { name: `اختيار إتمام ${secondStudent.body.student.name}` }).check();
    await owner.getByLabel(`سبب إتمام ${secondStudent.body.student.name} دون الحد`).fill("قرار استثنائي بعد مراجعة النواقص");
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة اعتماد الطلاب" }).click();
    await expect(owner.getByText(/إتمام استثنائي: قرار استثنائي بعد مراجعة النواقص/)).toBeVisible();
    await owner.locator("header.center-topbar").getByRole("button", { name: "تأكيد الاعتماد" }).click();
    await expect(owner.getByText("حُفظ اعتماد إتمام الطلاب المختارين.")).toBeVisible();
    await owner.reload();
    await expect(owner.getByRole("row", { name: new RegExp(secondStudent.body.student.name) })).toContainText("اكتمل استثنائيًا بقرار محفوظ");
    await expect(owner.getByRole("row", { name: new RegExp(secondStudent.body.student.name) })).toContainText("قرار استثنائي بعد مراجعة النواقص");
    await owner.getByRole("row", { name: new RegExp(student.body.student.name) }).getByRole("link", { name: "حالة الكورس" }).click();
    await expect(owner).toHaveURL(courseUrl);
    await expect(owner.getByText("اكتمل الكورس دراسيًا")).toBeVisible();
    await expect(owner.getByText("مكتمل بقرار محفوظ")).toBeVisible();
    await owner.goto(`${origin}/admin/students/${secondStudent.body.student.id}/courses/${course.body.course.id}/completion`);
    await expect(owner.getByText("مكتمل استثنائيًا بقرار محفوظ")).toBeVisible();
    await expect(owner.getByText(/قرار استثنائي بعد مراجعة النواقص/)).toBeVisible();
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.locator("html").getAttribute("dir")).toBe("rtl");
    await owner.getByRole("button", { name: "القائمة" }).click();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const hiddenCourse = await write(owner, "courses", { branch_id: south, name: `Hidden ${crypto.randomUUID().slice(0, 6)}`, request_id: crypto.randomUUID() });
    expect(hiddenCourse.status).toBe(201);
    const hiddenStage = await write(owner, `courses/${hiddenCourse.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
    const hiddenLevel = await write(owner, `stages/${hiddenStage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "Private", planned_hours: 1 }] });
    const hiddenInstructor = await write(owner, "instructors", { name: `Hidden teacher ${Date.now()}`, branch_ids: [south], request_id: crypto.randomUUID() });
    const hiddenGroup = await write(owner, "groups", { level_id: hiddenLevel.body.level.id, plan_version_id: hiddenLevel.body.level.plan.id,
      name: "Hidden group", approved_price: "0.00", instructor_ids: [hiddenInstructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(hiddenGroup.status).toBe(201);
    await signIn(staff, "staff");
    await staff.goto(url);
    await expect(staff.getByText(student.body.student.name)).toBeVisible();
    await expect(staff.locator("header.center-topbar").getByRole("button", { name: /معاينة اعتماد الطلاب/ })).toHaveCount(0);
    const denied = await staff.request.get(`${origin}/api/v1/center/groups/${hiddenGroup.body.group.id}/coverage`);
    expect(denied.status()).toBe(404);
    await staff.goto(`${origin}/admin/groups/${hiddenGroup.body.group.id}/coverage`);
    await expect(staff.getByText("Hidden group")).toHaveCount(0);
  } finally { await owner.close(); await staff.close(); }
});

import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_CORRECTION_CREDENTIALS || !process.env.COURSES_CORRECTION_DB_PORT || !process.env.COURSES_CORRECTION_QUERY_LOG,
  "Requires isolated PostgreSQL, browser credentials, and an SSR query log.");
const origin = process.env.COURSES_CORRECTION_ORIGIN ?? "http://alpha.courses.test:8066";
const credentials = process.env.COURSES_CORRECTION_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_CORRECTION_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff") {
  await page.goto(`${origin}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials[who].password);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, path: string, body: object, method = "POST") {
  return page.evaluate(async ({ path, body, method }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${path}`, { method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, { path, body, method });
}

test("academic owner corrects and revokes a held lecture with visible impact while branch viewer is denied", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const centerId = workspace.center.id as string;
    const course = await write(owner, "courses", { branch_id: north, name: `تصحيح ${Date.now()}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "مرحلة", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, {
      name: "مستوى", request_id: crypto.randomUUID(), lectures: [{ number: 1, content: "المحاضرة", planned_hours: 1 }],
    });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", { name: `مدرس ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", {
      level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: "مجموعة التصحيح", approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID(),
    });
    expect(group.status).toBe(201);
    const student = await write(owner, "students", { name: `طالب التصحيح ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const account = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/account`)).json();
    if (!account.account.currency) {
      expect((await write(owner, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
    }
    const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/enrollments`)).json();
    const joinedOn = new Date(Date.now() - 26 * 3_600_000).toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
    const saved = await write(owner, `students/${student.body.student.id}/enrollments`, {
      group_id: group.body.group.id, group_revision: group.body.group.revision,
      currency_revision: enrollment.student.currency_revision, joined_on: joinedOn,
      discount: "0.00", discount_reason: null, version: enrollment.student.version, request_id: crypto.randomUUID(),
    });
    expect(saved.status).toBe(201);
    const otherStudent = await write(owner, "students", { name: `طالب آخر ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(otherStudent.status).toBe(201);
    const otherEnrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${otherStudent.body.student.id}/enrollments`)).json();
    const otherSaved = await write(owner, `students/${otherStudent.body.student.id}/enrollments`, {
      group_id: group.body.group.id, group_revision: group.body.group.revision,
      currency_revision: otherEnrollment.student.currency_revision, joined_on: joinedOn,
      discount: "0.00", discount_reason: null, version: otherEnrollment.student.version, request_id: crypto.randomUUID(),
    });
    expect(otherSaved.status).toBe(201);
    const start = new Date(Date.now() + 14 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
    const session = await write(owner, `groups/${group.body.group.id}/sessions`, {
      kind: "single", revision: 1, start_at: start, plan_lecture_number: 1, request_id: crypto.randomUUID(),
    });
    expect(session.status).toBe(201);
    expect((await write(owner, `groups/${group.body.group.id}/start`, { revision: session.body.group_revision })).status).toBe(200);
    const sessionId = session.body.sessions[0].id as string;
    execFileSync(process.env.COURSES_CORRECTION_PSQL ?? "psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_CORRECTION_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_groups SET started_at = now() - interval '2 days' WHERE id = '${group.body.group.id}'; UPDATE study_sessions SET scheduled_at = now() - interval '1 hour' WHERE id = '${sessionId}'`], { stdio: "ignore" });
    const path = `groups/${group.body.group.id}/sessions/${sessionId}`;
    expect((await write(owner, `${path}/close`, { revision: 1, request_id: crypto.randomUUID() })).status).toBe(200);
    const url = `${origin}/admin/${path}/attendance`;
    const before = readFileSync(process.env.COURSES_CORRECTION_QUERY_LOG!, "utf8").trim().split("\n").length;
    const html = await (await owner.request.get(url)).text();
    expect(html).toContain(student.body.student.name);
    const reads = readFileSync(process.env.COURSES_CORRECTION_QUERY_LOG!, "utf8").trim().split("\n").slice(before)
      .map(line => JSON.parse(line) as { path: string; count: number | null }).filter(row => row.path.endsWith(`/sessions/${sessionId}/attendance`));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(row => Number.isInteger(row.count) && row.count! <= 6)).toBe(true);
    await signIn(staff, "staff");
    await staff.goto(url);
    await expect(staff.getByRole("row").filter({ hasText: student.body.student.name })).toBeVisible();
    await expect(staff.getByRole("button", { name: "تصحيح الحضور" })).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "معاينة إلغاء اعتماد المحاضرة" })).toHaveCount(0);
    expect((await staff.request.get(`${origin}/api/v1/center/${path}/revoke-preview`)).status()).toBe(403);
    await owner.goto(url);
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.getByRole("row").filter({ hasText: student.body.student.name }).getByRole("button", { name: "تصحيح الحضور" }).click();
    await owner.getByLabel("الحالة الصحيحة").selectOption("counted");
    await expect(owner.getByRole("row").filter({ hasText: otherStudent.body.student.name }).getByRole("button", { name: "تصحيح الحضور" })).toBeDisabled();
    await owner.getByRole("link", { name: "العودة لجدول المحاضرات" }).click();
    await expect(owner.getByRole("alertdialog", { name: "مغادرة دون حفظ" })).toBeVisible();
    await owner.getByRole("alertdialog").getByRole("button", { name: "إلغاء" }).click();
    await expect(owner.getByLabel("الحالة الصحيحة")).toHaveValue("counted");
    await owner.getByLabel("سبب التصحيح").fill("حضر مثبتًا في الكشف الورقي");
    await expect(owner.getByRole("row").filter({ hasText: otherStudent.body.student.name }).getByRole("button", { name: "تصحيح الحضور" })).toBeDisabled();
    await expect(owner.getByLabel("سبب التصحيح")).toHaveValue("حضر مثبتًا في الكشف الورقي");
    await owner.getByRole("banner").getByRole("button", { name: "حفظ التصحيح" }).click();
    await expect(owner.getByText("حُفظ تصحيح الحضور وسببه في سجل التدقيق.")).toBeVisible();
    await expect(owner.getByRole("row").filter({ hasText: student.body.student.name })).toContainText("حاضر محتسب");
    await owner.getByRole("banner").getByRole("button", { name: "معاينة إلغاء اعتماد المحاضرة" }).click();
    await expect(owner.getByText(/سيتأثر احتساب التغطية الحالي/)).toBeVisible();
    await owner.getByLabel("سبب إلغاء الاعتماد").fill("لا يعتمد هذا اللقاء أكاديميًا");
    await owner.getByRole("banner").getByRole("button", { name: "تأكيد إلغاء الاعتماد" }).click();
    await expect(owner.getByText("أُلغي اعتماد المحاضرة. بقي كشفها وتاريخها محفوظين، وأُعيد احتساب التقارير.")).toBeVisible();
    await expect(owner.getByText(/أُلغي اعتماد هذه المحاضرة/)).toBeVisible();
    await owner.goto(`${origin}/admin/groups/${group.body.group.id}/sessions`);
    await expect(owner.getByRole("row").filter({ hasText: "أُلغي اعتمادها" })).toBeVisible();
    await owner.goto(`${origin}/admin/groups/${group.body.group.id}/coverage`);
    await expect(owner.getByText(student.body.student.name)).toBeVisible();
    await expect(owner.getByRole("row").filter({ hasText: student.body.student.name })).toContainText("٠%");
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("إلغاء اعتماد محاضرة منعقدة").first()).toBeVisible();
    await staff.goto(url);
    await expect(staff.getByRole("row").filter({ hasText: student.body.student.name })).toBeVisible();
    await expect(staff.getByRole("button", { name: "تصحيح الحضور" })).toHaveCount(0);
    expect((await staff.request.get(`${origin}/api/v1/center/${path}/revoke-preview`)).status()).toBe(403);
  } finally { await owner.close(); await staff.close(); }
});

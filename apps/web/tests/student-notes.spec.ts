import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_NOTES_CREDENTIALS, "Requires a disposable PostgreSQL center fixture.");
const origin = process.env.COURSES_NOTES_ORIGIN ?? "http://alpha.courses.test:8068";
const credentials = process.env.COURSES_NOTES_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_NOTES_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff") {
  await page.goto(`${origin}/login`);
  await page.waitForLoadState("networkidle");
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

test("the note tab and short summary follow event permissions after each grant change", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id;
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south").id;
    const grant = (roles: Record<string, string[]>) => write(owner, `members/${credentials.staff.membership_id}/grants`,
      { center_roles: [], branch_roles: roles }, "PUT");
    const unique = crypto.randomUUID().slice(0, 8);
    const course = await write(owner, "courses", { branch_id: north, name: `Notes ${unique}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "Required", planned_hours: 1 }] });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", { name: `Teacher ${unique}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: `Group ${unique}`, approved_price: "100.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(group.status).toBe(201);
    const student = await write(owner, "students", { name: `Note Student ${unique}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const studentId = student.body.student.id;
    let enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
    if (!enrollment.student.currency) {
      expect((await write(owner, "financial-currency", { currency: "EGP", revision: enrollment.student.currency_revision }, "PATCH")).status).toBe(200);
      enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
    }
    const attempt = await write(owner, `students/${studentId}/enrollments`, { group_id: group.body.group.id,
      group_revision: group.body.group.revision, currency_revision: enrollment.student.currency_revision,
      joined_on: new Date().toISOString().slice(0, 10), discount: "0.00", discount_reason: null,
      version: enrollment.student.version, request_id: crypto.randomUUID() });
    expect(attempt.status).toBe(201);
    const longNote = `متابعة التسجيل ${"تفاصيل مختصرة ".repeat(15)}`;
    expect((await write(owner, `students/${studentId}/enrollments/${attempt.body.attempt.id}/note`,
      { body: longNote, important: true, revision: 0, request_id: crypto.randomUUID() }, "PUT")).status).toBe(201);
    const account = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
    const payment = await write(owner, `students/${studentId}/payments`, { branch_id: north, method: "cash",
      received_on: new Date().toISOString().slice(0, 10), amount: "40.00", version: account.account.version,
      request_id: crypto.randomUUID() });
    expect(payment.status).toBe(201);
    expect((await write(owner, `students/${studentId}/payments/${payment.body.payment.id}/note`,
      { body: "مراجعة دفعة الطالب", important: true, revision: 0, request_id: crypto.randomUUID() }, "PUT")).status).toBe(201);

    await owner.goto(`${origin}/admin/students/${studentId}`);
    await expect(owner.getByRole("region", { name: "الملاحظات المهمة" })).toBeVisible();
    const summary = owner.getByRole("region", { name: "الملاحظات المهمة" });
    await expect(summary.getByRole("link")).toHaveCount(3);
    await expect(summary).not.toContainText(longNote);
    await owner.getByRole("link", { name: "الملاحظات", exact: true }).click();
    await expect(owner.getByRole("region", { name: "ملاحظات أحداث الطالب" })).toContainText("مراجعة دفعة الطالب");
    await expect(owner.getByRole("region", { name: "ملاحظات أحداث الطالب" })).toContainText("متابعة التسجيل");
    const measured = await owner.request.get(`${origin}/api/v1/center/students/${studentId}?tab=notes`);
    expect(Number(measured.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.context().addCookies([{ name: "courses_theme", value: "dark", domain: "alpha.courses.test", path: "/" }]);
    await owner.reload();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(owner.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(owner.getByRole("region", { name: "ملاحظات أحداث الطالب" })).toBeVisible();

    expect((await grant({ [north]: ["registration"] })).status).toBe(200);
    await signIn(staff, "staff");
    await staff.goto(`${origin}/admin/students/${studentId}?tab=notes`);
    await expect(staff.getByRole("region", { name: "ملاحظات أحداث الطالب" })).toContainText("متابعة التسجيل");
    await expect(staff.getByRole("region", { name: "ملاحظات أحداث الطالب" })).not.toContainText("مراجعة دفعة الطالب");
    await staff.getByRole("button", { name: "عرض النسخ" }).click();
    await expect(staff.getByText("نسخة ١", { exact: true })).toBeVisible();

    expect((await grant({ [north]: ["attendance"] })).status).toBe(200);
    await staff.reload();
    await expect(staff.getByRole("region", { name: "ملاحظات أحداث الطالب" })).toContainText("متابعة التسجيل");
    await expect(staff.getByRole("region", { name: "ملاحظات أحداث الطالب" })).not.toContainText("مراجعة دفعة الطالب");
    expect((await grant({ [north]: ["accounting"] })).status).toBe(200);
    await staff.reload();
    await expect(staff.getByRole("region", { name: "ملاحظات أحداث الطالب" })).toContainText("مراجعة دفعة الطالب");
    expect((await grant({ [north]: ["branch_viewer"] })).status).toBe(200);
    await staff.reload();
    await expect(staff.getByRole("region", { name: "ملاحظات أحداث الطالب" })).not.toContainText("مراجعة دفعة الطالب");
    expect((await grant({ [south]: ["registration"] })).status).toBe(200);
    await staff.reload();
    await expect(staff.getByText("ملف الطالب غير متاح")).toBeVisible();
    expect((await grant({ [north]: ["registration"] })).status).toBe(200);
  } finally {
    await owner.close(); await staff.close();
  }
});

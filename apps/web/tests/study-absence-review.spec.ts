import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_ABSENCE_CREDENTIALS || !process.env.COURSES_ABSENCE_DB_PORT || !process.env.COURSES_ABSENCE_QUERY_LOG,
  "Requires isolated PostgreSQL, browser credentials, and an SSR query log.");
const origin = process.env.COURSES_ABSENCE_ORIGIN ?? "http://alpha.courses.test:8066";
const credentials = process.env.COURSES_ABSENCE_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_ABSENCE_CREDENTIALS, "utf8")) : {};

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
    const response = await fetch(`/api/v1/center/${path}`, {
      method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, { path, body, method });
}

test("authorized absence rule updates the Arabic report and a branch reader cannot change it", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south").id as number;
    const centerId = workspace.center.id as string;
    const course = await write(owner, "courses", { branch_id: north, name: `غياب ${Date.now()}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const hidden = await write(owner, "courses", { branch_id: south, name: `Hidden ${Date.now()}`, request_id: crypto.randomUUID() });
    expect(hidden.status).toBe(201);
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
      name: "مجموعة الغياب", approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID(),
    });
    expect(group.status).toBe(201);
    const student = await write(owner, "students", { name: `طالب الغياب ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const account = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/account`)).json();
    if (!account.account.currency) {
      expect((await write(owner, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
    }
    const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/enrollments`)).json();
    const joinedOn = new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
    const saved = await write(owner, `students/${student.body.student.id}/enrollments`, {
      group_id: group.body.group.id, group_revision: group.body.group.revision,
      currency_revision: enrollment.student.currency_revision, joined_on: joinedOn,
      discount: "0.00", discount_reason: null, version: enrollment.student.version, request_id: crypto.randomUUID(),
    });
    expect(saved.status).toBe(201);
    const start = new Date(Date.now() + 14 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
    const session = await write(owner, `groups/${group.body.group.id}/sessions`, {
      kind: "single", revision: 1, start_at: start, plan_lecture_number: 1, request_id: crypto.randomUUID(),
    });
    expect(session.status).toBe(201);
    expect((await write(owner, `groups/${group.body.group.id}/start`, { revision: session.body.group_revision })).status).toBe(200);
    execFileSync("/Users/Shared/DBngin/postgresql/18.4_arm/bin/psql", ["-h", "127.0.0.1", "-p", process.env.COURSES_ABSENCE_DB_PORT!, "-U", "postgres",
      "-d", `courses_center_${centerId}`, "-c",
      `UPDATE study_groups SET started_at = now() - interval '2 days' WHERE id = '${group.body.group.id}'; UPDATE study_sessions SET scheduled_at = now() - interval '1 hour' WHERE id = '${session.body.sessions[0].id}'`], { stdio: "ignore" });
    const closed = await write(owner, `groups/${group.body.group.id}/sessions/${session.body.sessions[0].id}/close`, {
      revision: 1, request_id: crypto.randomUUID(),
    });
    expect(closed.status).toBe(200);
    expect(closed.body.absent_count).toBe(1);

    const direct = await owner.request.get(`${origin}/api/v1/center/absence-review?view=all`);
    expect(direct.status(), await direct.text()).toBe(200);
    const before = readFileSync(process.env.COURSES_ABSENCE_QUERY_LOG!, "utf8").trim().split("\n").length;
    const html = await (await owner.request.get(`${origin}/admin/absence-review?view=all`)).text();
    expect(html).toContain(student.body.student.name);
    const reads = readFileSync(process.env.COURSES_ABSENCE_QUERY_LOG!, "utf8").trim().split("\n").slice(before)
      .map(line => JSON.parse(line) as { path: string; count: number | null }).filter(row => row.path === "/api/v1/center/absence-review");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(row => Number.isInteger(row.count) && row.count! <= 6)).toBe(true);

    await owner.goto(`${origin}/admin/absence-review?view=all`);
    await expect(owner.getByText(student.body.student.name)).toBeVisible();
    await owner.getByLabel("النطاق المراد تعديله").selectOption(`courses:${course.body.course.id}`);
    await owner.getByLabel("نوع القاعدة").selectOption("total");
    await owner.getByLabel("الحد").fill("1");
    await owner.getByRole("button", { name: "حفظ قاعدة الغياب" }).click();
    await expect(owner.getByText("حُفظت قاعدة الغياب وأُعيد حساب التقرير الحالي.")).toBeVisible();
    await owner.getByLabel("نوع القاعدة").selectOption("consecutive");
    await owner.getByRole("button", { name: "حفظ قاعدة الغياب" }).click();
    await expect(owner.getByText("حُفظت قاعدة الغياب وأُعيد حساب التقرير الحالي.")).toBeVisible();
    await expect(owner.getByText("تغيرت القاعدة في جلسة أخرى.")).toHaveCount(0);
    await owner.getByLabel("الحد").fill("0");
    await owner.getByRole("button", { name: "حفظ قاعدة الغياب" }).click();
    await expect(owner.getByLabel("الحد")).toBeFocused();
    await owner.getByRole("button", { name: "إلغاء التعديل" }).click();
    await expect(owner.getByLabel("النطاق المراد تعديله")).toBeFocused();
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("تعديل قاعدة تنبيه الغياب").first()).toBeVisible();
    await owner.getByText("عرض تغيير قاعدة الغياب").first().click();
    await expect(owner.getByText("بعد: ١ غياب متتالٍ").first()).toBeVisible();
    await owner.goto(`${origin}/admin/absence-review`);
    await expect(owner.getByText(student.body.student.name)).toBeVisible();
    await expect(owner.getByRole("row").filter({ hasText: student.body.student.name }).getByRole("cell", { name: "يحتاج مراجعة" })).toBeVisible();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "light");
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.setViewportSize({ width: 390, height: 844 });
    await expect(owner.getByRole("heading", { name: "نطاق التقرير" })).toBeVisible();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    await signIn(staff, "staff");
    await staff.goto(`${origin}/admin/absence-review?view=all`);
    await expect(staff.getByText(student.body.student.name)).toBeVisible();
    await expect(staff.getByRole("button", { name: "حفظ قاعدة الغياب" })).toHaveCount(0);
    expect((await write(staff, `absence-rules/courses/${course.body.course.id}`, { mode: "disabled", limit: null, revision: 2 }, "PATCH")).status).toBe(403);
    expect((await staff.request.get(`${origin}/api/v1/center/absence-options?q=Hidden`)).status()).toBe(200);
    expect((await (await staff.request.get(`${origin}/api/v1/center/absence-options?q=Hidden`)).json()).options).toHaveLength(0);
    expect((await write(staff, `absence-rules/courses/${hidden.body.course.id}`, { mode: "disabled", limit: null, revision: 1 }, "PATCH")).status).toBe(404);
  } finally { await owner.close(); await staff.close(); }
});

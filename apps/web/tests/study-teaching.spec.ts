import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test.skip(!process.env.COURSES_TEACHING_CREDENTIALS || !process.env.COURSES_TEACHING_QUERY_LOG,
  "Requires isolated center credentials and an SSR query log.");
const origin = process.env.COURSES_TEACHING_ORIGIN ?? "http://alpha.courses.test:8091";
const credentials = process.env.COURSES_TEACHING_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_TEACHING_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff") {
  await page.goto(`${origin}/login`);
  await page.waitForLoadState("networkidle");
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

function makeSessionDue(groupId: string, sessionId: string) {
  const code = `$center = App\\Models\\Center::where('slug', 'alpha')->firstOrFail();
    $center->run(function () {
      Illuminate\\Support\\Facades\\DB::table('study_groups')->where('id', '${groupId}')
        ->update(['started_at' => now()->subDay()]);
      Illuminate\\Support\\Facades\\DB::table('study_sessions')->where('id', '${sessionId}')
        ->update(['scheduled_at' => now()->subHours(2)]);
    });`;
  execFileSync("php85", ["artisan", "tinker", "--execute", code], {
    cwd: resolve(process.cwd(), "../api"), stdio: "pipe",
  });
}

test("actual teaching, substitute overlap, correction, branch denial, and SSR budget", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south").id as number;
    const course = await write(owner, "courses", { branch_id: north, name: `تدريس فعلي ${Date.now()}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "مرحلة", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, {
      name: "مستوى", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "محاضرة التدريس", planned_hours: 2 }],
    });
    expect(level.status).toBe(201);
    const assigned = await write(owner, "instructors", { name: `محاضر أساسي ${Date.now()}`,
      branch_ids: [north], request_id: crypto.randomUUID() });
    const substitute = await write(owner, "instructors", { name: `محاضر بديل ${Date.now()}`,
      branch_ids: [north], request_id: crypto.randomUUID() });
    expect(assigned.status).toBe(201);
    expect(substitute.status).toBe(201);
    const group = await write(owner, "groups", {
      level_id: level.body.level.id, plan_version_id: level.body.level.plan.id, name: "مجموعة التدريس",
      approved_price: "0.00", instructor_ids: [assigned.body.instructor.id], request_id: crypto.randomUUID(),
    });
    expect(group.status).toBe(201);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
    const session = await write(owner, `groups/${group.body.group.id}/sessions`, {
      kind: "single", revision: 1, start_at: `${tomorrow}T16:00`, plan_lecture_number: 1,
      request_id: crypto.randomUUID(),
    });
    expect(session.status).toBe(201);
    expect((await write(owner, `groups/${group.body.group.id}/start`, { revision: 2 })).status).toBe(200);
    const sessionId = session.body.sessions[0].id as string;
    const url = `${origin}/admin/groups/${group.body.group.id}/sessions/${sessionId}/teaching`;
    await owner.goto(url);
    await expect(owner.getByText("يمكن تسجيل التدريس بعد بدء المجموعة")).toBeVisible();
    makeSessionDue(group.body.group.id, sessionId);
    const log = process.env.COURSES_TEACHING_QUERY_LOG!;
    const before = readFileSync(log, "utf8").trim().split("\n").length;
    const html = await (await owner.request.get(url)).text();
    expect(html).toContain("التدريس الفعلي");
    const reads = readFileSync(log, "utf8").trim().split("\n").slice(before)
      .map(line => JSON.parse(line) as { path: string; count: number | null })
      .filter(row => row.path.endsWith(`/groups/${group.body.group.id}/sessions/${sessionId}/teaching`));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(row => Number.isInteger(row.count) && row.count! <= 6)).toBe(true);
    await owner.reload();
    await owner.getByRole("button", { name: "إضافة محاضر أو فترة" }).click();
    await owner.getByRole("button", { name: "إضافة محاضر أو فترة" }).click();
    await owner.getByRole("searchbox", { name: "البحث عن محاضر بديل أو مشارك في الفرع" }).fill(substitute.body.instructor.name);
    await owner.getByRole("button", { name: "بحث", exact: true }).click();
    await expect(owner.getByRole("combobox", { name: "المحاضر", exact: true }).nth(1)
      .locator(`option[value="${substitute.body.instructor.id}"]`)).toHaveCount(1);
    await owner.getByRole("combobox", { name: "المحاضر", exact: true }).nth(1).selectOption(substitute.body.instructor.id);
    await owner.getByLabel("البداية من موعد المحاضرة (دقيقة)").nth(1).fill("30");
    await owner.getByLabel("مدة التدريس (دقيقة)").nth(1).fill("60");
    await owner.getByRole("button", { name: "حفظ التدريس الفعلي" }).click();
    await expect(owner.getByText("حُفظ سجل التدريس الفعلي وسبب التصحيح في سجل التدقيق.")).toBeVisible();
    await expect(owner.getByRole("heading", { name: "السجل المحفوظ" }).locator("..")).toContainText(substitute.body.instructor.name);
    await owner.reload();
    await owner.getByLabel("البداية من موعد المحاضرة (دقيقة)").nth(1).fill("60");
    await owner.getByLabel("سبب التصحيح (مطلوب)").fill("تصحيح بداية المحاضر البديل");
    await owner.getByRole("button", { name: "حفظ التدريس الفعلي" }).click();
    await expect(owner.getByText("حُفظ سجل التدريس الفعلي وسبب التصحيح في سجل التدقيق.")).toBeVisible();
    const saved = await (await owner.request.get(`${origin}/api/v1/center/groups/${group.body.group.id}/sessions/${sessionId}/teaching`)).json();
    expect(saved.session.segments).toHaveLength(2);
    expect(saved.session.segments.some((row: { instructor_id: string; start_minute: number }) =>
      row.instructor_id === substitute.body.instructor.id && row.start_minute === 60)).toBe(true);
    await expect(owner.locator("html")).toHaveAttribute("dir", "rtl");
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("تصحيح التدريس الفعلي لمحاضرة").first()).toBeVisible();
    await owner.getByText("تفاصيل التدريس الفعلي").first().click();
    await expect(owner.getByText("سبب التصحيح: تصحيح بداية المحاضر البديل").first()).toBeVisible();

    const members = await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json();
    const original = members.members.find((member: { id: number }) => member.id === credentials.staff.membership_id);
    expect(original).toBeTruthy();
    const grantPath = `members/${credentials.staff.membership_id}/grants`;
    expect((await write(owner, grantPath, { center_roles: [], branch_roles: { [south]: ["branch_viewer"] } }, "PUT")).status).toBe(200);
    try {
      await signIn(staff, "staff");
      await staff.goto(url);
      await expect(staff.getByText(substitute.body.instructor.name, { exact: false })).toHaveCount(0);
      expect((await write(staff, `groups/${group.body.group.id}/sessions/${sessionId}/teaching`, {
        revision: 1, request_id: crypto.randomUUID(), segments: [],
      }, "PUT")).status).toBe(404);
    } finally {
      expect((await write(owner, grantPath, {
        center_roles: original.center_roles, branch_roles: original.branch_roles,
      }, "PUT")).status).toBe(200);
    }
  } finally { await owner.close(); await staff.close(); }
});

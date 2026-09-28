import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_BULK_CREDENTIALS || !process.env.COURSES_BULK_QUERY_LOG,
  "Requires isolated center credentials and an SSR query log.");
const origin = process.env.COURSES_BULK_ORIGIN ?? "http://alpha.courses.test:8077";
const credentials = process.env.COURSES_BULK_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_BULK_CREDENTIALS, "utf8")) : {};

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

test("bulk preview, individual outcome, forbidden branch, and SSR budget", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south").id as number;
    const course = await write(owner, "courses", { branch_id: north, name: `نقل جماعي ${Date.now()}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "مرحلة", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, {
      name: "مستوى", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "المحاضرة", planned_hours: 1 }],
    });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", {
      name: `مدرس النقل ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID(),
    });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", {
      level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: "مجموعة النقل", approved_price: "0.00", instructor_ids: [instructor.body.instructor.id],
      request_id: crypto.randomUUID(),
    });
    expect(group.status).toBe(201);
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
    const people = [];
    for (const name of ["أحمد", "سارة"]) {
      const student = await write(owner, "students", {
        name: `${name} النقل ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID(),
      });
      expect(student.status).toBe(201);
      const account = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/account`)).json();
      if (!account.account.currency) {
        expect((await write(owner, "financial-currency", {
          currency: "EGP", revision: account.account.currency_revision,
        }, "PATCH")).status).toBe(200);
      }
      const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/enrollments`)).json();
      const saved = await write(owner, `students/${student.body.student.id}/enrollments`, {
        group_id: group.body.group.id, group_revision: group.body.group.revision,
        currency_revision: enrollment.student.currency_revision, joined_on: today,
        discount: "0.00", discount_reason: null, version: enrollment.student.version,
        request_id: crypto.randomUUID(),
      });
      expect(saved.status).toBe(201);
      people.push({ name: student.body.student.name as string, id: student.body.student.id as string });
    }
    const url = `${origin}/admin/absence-review?view=all&group_id=${group.body.group.id}`;
    const log = process.env.COURSES_BULK_QUERY_LOG!;
    const before = readFileSync(log, "utf8").trim().split("\n").length;
    const html = await (await owner.request.get(url)).text();
    expect(html).toContain(people[0].name);
    const reads = readFileSync(log, "utf8").trim().split("\n").slice(before)
      .map(line => JSON.parse(line) as { path: string; count: number | null })
      .filter(row => row.path.startsWith("/api/v1/center/absence-review"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(row => Number.isInteger(row.count) && row.count! <= 6)).toBe(true);

    await owner.goto(url);
    await owner.getByRole("checkbox", { name: `اختيار ${people[0].name} للنقل إلى الانتظار` }).check();
    await expect(owner.getByLabel("طريقة الاختيار").locator('option[value="selected"]')).toHaveText("طلاب محددون (١)");
    await owner.getByLabel("عرض").selectOption("review");
    await owner.getByRole("button", { name: "تطبيق النطاق" }).click();
    await expect(owner).toHaveURL(/view=review/);
    await expect(owner.getByLabel("طريقة الاختيار").locator('option[value="selected"]')).toHaveText("طلاب محددون (٠)");
    await owner.getByLabel("عرض").selectOption("all");
    await owner.getByRole("button", { name: "تطبيق النطاق" }).click();
    await expect(owner).toHaveURL(/view=all/);
    await owner.getByRole("checkbox", { name: `اختيار ${people[0].name} للنقل إلى الانتظار` }).check();
    await owner.getByLabel("سبب النقل").fill("مراجعة جماعية بعد الغياب");
    await owner.getByRole("button", { name: "معاينة النقل" }).click();
    await expect(owner.getByRole("heading", { name: "معاينة الدفعة ونتيجتها" })).toBeFocused();
    await expect(owner.getByText("الإجمالي: ١ · نُقل: ٠ · استُبعد: ٠ · ينتظر التنفيذ: ١")).toBeVisible();
    await expect(owner.getByRole("region", { name: "نتائج النقل الجماعي" })).toContainText(people[0].name);
    await owner.reload();
    await expect(owner.getByRole("region", { name: "نتائج النقل الجماعي" })).toContainText(people[0].name);
    await owner.getByRole("button", { name: "تأكيد نقل المؤهلين" }).click();
    await expect(owner.getByText("اكتمل نقل ١ طالب إلى الانتظار.")).toBeVisible();
    await expect(owner.getByRole("checkbox", { name: `اختيار ${people[0].name} للنقل إلى الانتظار` })).toHaveCount(0);
    await owner.reload();
    await expect(owner.getByRole("row").filter({ hasText: people[0].name })).toHaveCount(1);
    await expect(owner.getByRole("region", { name: "نتائج النقل الجماعي" })).toContainText("نُقل إلى الانتظار");

    await owner.goto(url);
    await expect(owner.getByRole("checkbox", { name: `اختيار ${people[0].name} للنقل إلى الانتظار` })).toHaveCount(0);
    await expect(owner.getByRole("checkbox", { name: `اختيار ${people[1].name} للنقل إلى الانتظار` })).toBeVisible();
    await owner.getByLabel("طريقة الاختيار").selectOption("all");
    await owner.getByLabel("سبب النقل").fill("نقل باقي النطاق");
    await owner.getByRole("button", { name: "معاينة النقل" }).click();
    await expect(owner.getByText("الإجمالي: ١ · نُقل: ٠ · استُبعد: ٠ · ينتظر التنفيذ: ١")).toBeVisible();
    await owner.getByRole("button", { name: "تأكيد نقل المؤهلين" }).click();
    await expect(owner.getByText("اكتمل نقل ١ طالب إلى الانتظار.")).toBeVisible();
    await expect(owner.getByRole("checkbox", { name: `اختيار ${people[1].name} للنقل إلى الانتظار` })).toHaveCount(0);
    await owner.goto(url);
    await expect(owner.getByText("لا توجد حالات ضمن هذا النطاق.")).toBeVisible();
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("نقل الطالب إلى انتظار المستوى").first()).toBeVisible();
    await owner.getByText("تفاصيل انتقال محاولة الدراسة").first().click();
    await expect(owner.getByText("دفعة النقل:").first()).toBeVisible();

    await expect(owner.locator("html")).toHaveAttribute("dir", "rtl");
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    const members = await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json();
    const original = members.members.find((member: { id: number }) => member.id === credentials.staff.membership_id);
    expect(original).toBeTruthy();
    const grantPath = `members/${credentials.staff.membership_id}/grants`;
    expect((await write(owner, grantPath, { center_roles: [], branch_roles: { [north]: ["branch_viewer"] } }, "PUT")).status).toBe(200);
    try {
      await signIn(staff, "staff");
      await staff.goto(url);
      await expect(staff.getByRole("button", { name: "معاينة النقل" })).toHaveCount(0);
      await expect(staff.getByLabel("طريقة الاختيار")).toHaveCount(0);
      expect((await write(staff, "absence-review/waitlist-batches", {
        selection_mode: "all", branch_id: south, view: "all", entered_on: today, reason: "مرفوض",
      })).status).toBe(404);
    } finally {
      expect((await write(owner, grantPath, {
        center_roles: original.center_roles, branch_roles: original.branch_roles,
      }, "PUT")).status).toBe(200);
    }
  } finally { await owner.close(); await staff.close(); }
});

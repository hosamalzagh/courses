import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

test.skip(!process.env.COURSES_GROUPS_CREDENTIALS, "Requires the disposable PostgreSQL center fixture.");
const origin = process.env.COURSES_GROUPS_ORIGIN ?? "http://alpha.courses.test:8057";
const credentials = process.env.COURSES_GROUPS_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_GROUPS_CREDENTIALS, "utf8")) : {};
const queryLog = process.env.COURSES_GROUPS_QUERY_LOG;
function reads() {
  return queryLog && existsSync(queryLog) ? readFileSync(queryLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { path: string; count: number | null }) : [];
}

async function signIn(page: Page, who: "alpha" | "staff" = "alpha") {
  await page.goto(`${origin}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).pressSequentially(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).pressSequentially(credentials[who].password);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, route: string, method: "POST" | "PATCH" | "PUT", payload: object) {
  return page.evaluate(async ({ route, method, payload }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: "same-origin", body: JSON.stringify(payload),
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
    });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
}

test("group settings, instructors, start and branch revocation work through the employee UI", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    await signIn(staff, "staff");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north");
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south");
    const stamp = Date.now();
    const course = await write(owner, "courses", "POST", { branch_id: north.id, name: `مجموعة قبول ${stamp}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, "POST", { name: "مرحلة قبول", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, "POST", {
      name: "مستوى قبول", request_id: crypto.randomUUID(), lectures: [{ number: 1, content: "محتوى مطلوب", planned_hours: 2 }],
    });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", "POST", { name: `محاضر ${stamp}`, branch_ids: [north.id], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    expect((await write(owner, `courses/${course.body.course.id}/completion-threshold`, "PATCH", { revision: 1, completion_threshold: 85 })).status).toBe(200);

    const beforePage = reads().length;
    await owner.goto(`${origin}/admin/groups`);
    await expect(owner.getByRole("heading", { name: "المجموعات" }).first()).toBeVisible();
    if (queryLog) {
      const pageReads = reads().slice(beforePage).filter(row => row.path === "/api/v1/center/group-workspace");
      expect(pageReads).toHaveLength(1);
      expect(pageReads[0].count).toBeLessThanOrEqual(6);
    }
    const read = await owner.request.get(`${origin}/api/v1/center/group-workspace`);
    expect(Number(read.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    await owner.getByRole("button", { name: "إنشاء مجموعة" }).click();
    await expect(owner.getByRole("textbox", { name: "اسم المجموعة" })).toBeFocused();
    await owner.getByRole("button", { name: "حفظ المجموعة" }).click();
    await expect(owner.getByLabel("المستوى وإصدار الخطة")).toBeFocused();
    await owner.getByLabel("المستوى وإصدار الخطة").selectOption(level.body.level.plan.id);
    await owner.getByRole("button", { name: "حفظ المجموعة" }).click();
    await expect(owner.getByRole("textbox", { name: "اسم المجموعة" })).toBeFocused();
    await owner.getByRole("textbox", { name: "اسم المجموعة" }).fill(`صباح ${stamp}`);
    await owner.getByRole("textbox", { name: "السعر المعتمد للمجموعة" }).fill("0.00");
    await owner.getByLabel("نسبة الإتمام للمجموعة").selectOption("75");
    await expect(owner.getByText(`محاضر ${stamp}`)).toBeVisible();
    await owner.getByText(`محاضر ${stamp}`).click();
    await owner.getByRole("button", { name: "حفظ المجموعة" }).click();
    await expect(owner.getByRole("button", { name: `إدارة صباح ${stamp}` })).toBeVisible();
    await owner.getByRole("button", { name: `إدارة صباح ${stamp}` }).click();
    await expect(owner.getByRole("heading", { name: `إعدادات صباح ${stamp}` })).toBeFocused();
    await expect(owner.getByRole("region", { name: "المحاضرات المطلوبة للمجموعة" })).toContainText("محتوى مطلوب");
    await expect(owner.getByLabel("نسبة الإتمام للمجموعة")).toHaveValue("75");
    await owner.getByRole("textbox", { name: "السعر المعتمد للمجموعة" }).fill("-1");
    await owner.getByRole("button", { name: "حفظ المجموعة" }).click();
    await expect(owner.getByRole("textbox", { name: "السعر المعتمد للمجموعة" })).toBeFocused();
    await owner.getByRole("textbox", { name: "السعر المعتمد للمجموعة" }).fill("0.00");
    await owner.getByLabel("نسبة الإتمام للمجموعة").selectOption("");
    await owner.getByRole("button", { name: "حفظ المجموعة" }).click();
    await expect(owner.getByRole("row", { name: new RegExp(`صباح ${stamp}`) })).toContainText("٨٥٪");
    await owner.goto(`${origin}/admin/curriculum`);
    const courseRow = owner.getByRole("row").filter({ hasText: course.body.course.name });
    await courseRow.getByRole("button", { name: "تحديد نسبة الإتمام" }).click();
    await expect(owner.getByLabel("نسبة الإتمام المطلوبة")).toBeFocused();
    await owner.getByLabel("نسبة الإتمام المطلوبة").selectOption("90");
    const thresholdSaved = owner.waitForResponse(response => response.url().endsWith(`/courses/${course.body.course.id}/completion-threshold`) && response.request().method() === "PATCH");
    await owner.getByRole("button", { name: "حفظ نسبة الإتمام" }).click();
    expect((await thresholdSaved).status()).toBe(200);
    await expect(owner.getByText("حُفظت نسبة الإتمام للطلاب الجدد ضمن هذا النطاق.")).toBeVisible();
    await owner.goto(`${origin}/admin/groups`);
    await expect(owner.getByRole("row", { name: new RegExp(`صباح ${stamp}`) })).toContainText("٩٠٪");
    await owner.getByRole("button", { name: `إدارة صباح ${stamp}` }).click();
    await owner.getByRole("button", { name: "بدء المجموعة" }).click();
    await owner.getByRole("alertdialog").getByRole("button", { name: "بدء المجموعة" }).click();
    await expect(owner.getByRole("row", { name: new RegExp(`صباح ${stamp}`) })).toContainText("بدأت");

    expect((await write(owner, `members/${credentials.staff.membership_id}/grants`, "PUT", {
      center_roles: [], branch_roles: { [north.id]: ["academic_admin"] },
    })).status).toBe(200);
    await staff.goto(`${origin}/admin/groups`);
    await expect(staff.getByRole("button", { name: `إدارة صباح ${stamp}` })).toBeVisible();
    await staff.getByRole("button", { name: `إدارة صباح ${stamp}` }).click();
    expect((await staff.request.get(`${origin}/api/v1/center/group-instructor-options?branch_id=${south.id}`)).status()).toBe(404);
    expect((await write(owner, `members/${credentials.staff.membership_id}/grants`, "PUT", {
      center_roles: [], branch_roles: { [north.id]: ["registration"] },
    })).status).toBe(200);
    await staff.getByRole("textbox", { name: "السعر المعتمد للمجموعة" }).fill("100.00");
    await staff.getByRole("button", { name: "حفظ المجموعة" }).click();
    await expect(staff.getByRole("alert").filter({ hasText: "هذه العملية خارج صلاحيتك" })).toBeVisible();

    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.locator("html").getAttribute("dir")).toBe("rtl");
    await owner.getByRole("button", { name: "القائمة" }).click();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.getByRole("button", { name: "إغلاق القائمة" }).click();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("بدء مجموعة")).toBeVisible();
  } finally {
    await owner.close();
    await staff.close();
  }
});

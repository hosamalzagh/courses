import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

test.skip(!process.env.COURSES_SESSIONS_CREDENTIALS, "Requires an isolated PostgreSQL center fixture.");
const origin = process.env.COURSES_SESSIONS_ORIGIN ?? "http://alpha.courses.test:8066";
const credentials = process.env.COURSES_SESSIONS_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_SESSIONS_CREDENTIALS, "utf8")) : {};
const queryLog = process.env.COURSES_SESSIONS_QUERY_LOG;
function reads() {
  return queryLog && existsSync(queryLog) ? readFileSync(queryLog, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { path: string; count: number | null }) : [];
}
async function signIn(page: Page, who: "alpha" | "staff" = "alpha") {
  await page.goto(`${origin}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials[who].password);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
async function write(page: Page, route: string, payload: object, method: "POST" | "PUT" = "POST") {
  return page.evaluate(async ({ route, payload, method }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: "same-origin", body: JSON.stringify(payload),
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}
function localTime(days: number) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(Date.now() + days * 86400000)).replace(" ", "T");
}

test("cancelled unheld lecture keeps the requirement and a linked replacement in the real center UI", async ({ page, browser }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branch = workspace.branches.find((item: { slug: string }) => item.slug === "north");
  const stamp = Date.now();
  const course = await write(page, "courses", { branch_id: branch.id, name: `إلغاء ${stamp}`, request_id: crypto.randomUUID() });
  expect(course.status).toBe(201);
  const stage = await write(page, `courses/${course.body.course.id}/stages`, { name: "مرحلة الإلغاء", request_id: crypto.randomUUID() });
  expect(stage.status).toBe(201);
  const level = await write(page, `stages/${stage.body.stage.id}/levels`, {
    name: "مستوى الإلغاء", lectures: [{ number: 1, content: "محتوى أساسي", planned_hours: 2 }], request_id: crypto.randomUUID(),
  });
  expect(level.status).toBe(201);
  const instructor = await write(page, "instructors", { name: `محاضر ${stamp}`, branch_ids: [branch.id], request_id: crypto.randomUUID() });
  expect(instructor.status).toBe(201);
  const group = await write(page, "groups", {
    level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
    name: `مجموعة الإلغاء ${stamp}`, approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID(),
  });
  expect(group.status).toBe(201);
  const groupId = group.body.group.id;
  const path = `/admin/groups/${groupId}/sessions`;
  const apiPath = `/api/v1/center/groups/${groupId}/sessions`;
  const beforePage = reads().length;
  await page.goto(`${origin}${path}`);
  await expect(page.getByRole("heading", { name: new RegExp(`مجموعة الإلغاء ${stamp}`) })).toBeVisible();
  if (queryLog) {
    const pageReads = reads().slice(beforePage).filter(item => item.path === apiPath);
    expect(pageReads).toHaveLength(1);
    expect(pageReads[0].count).toBeLessThanOrEqual(6);
  }
  await page.getByLabel("المحاضرة المعتمدة").selectOption("1");
  await page.getByLabel("موعد المحاضرة بتوقيت القاهرة").fill(localTime(15));
  await page.getByRole("button", { name: "معاينة المواعيد" }).click();
  await page.getByRole("button", { name: /تأكيد وحفظ/ }).click();
  await expect(page.getByRole("button", { name: "إلغاء الموعد" })).toBeVisible();
  await page.getByRole("button", { name: "إلغاء الموعد" }).click();
  await expect(page.getByRole("textbox", { name: "سبب الإلغاء" })).toBeFocused();
  await page.getByRole("textbox", { name: "سبب الإلغاء" }).fill("تعذر تجهيز القاعة");
  await page.getByLabel("قرار التعويض").selectOption("academic");
  await page.getByRole("button", { name: "معاينة الإلغاء" }).click();
  await expect(page.getByRole("heading", { name: "تأكيد إلغاء الموعد" })).toBeFocused();
  await expect(page.getByText("تبقى ١ محاضرة معتمدة للمجموعة", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "تأكيد إلغاء الموعد" }).click();
  await expect(page.getByText("أُلغي الموعد وبقي متطلب المحاضرة", { exact: false })).toBeVisible();
  await expect(page.getByText("غير المجدولة: ٠", { exact: false })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("تعذر تجهيز القاعة");
  await page.getByRole("button", { name: "جدولة البديل" }).click();
  await expect(page.getByLabel("موعد البديل بتوقيت القاهرة")).toBeFocused();
  await page.getByLabel("موعد البديل بتوقيت القاهرة").fill(localTime(30));
  await page.getByRole("button", { name: "معاينة البديل" }).click();
  await expect(page.getByRole("heading", { name: "تأكيد الموعد البديل" })).toBeFocused();
  await page.getByRole("button", { name: "تأكيد حفظ البديل" }).click();
  await expect(page.getByText("حُفظ الموعد البديل", { exact: false })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("بديل للموعد ١");
  await expect(page.getByRole("table")).toContainText("البديل ٢");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);
  await page.getByRole("button", { name: "محاضرة إضافية" }).click();
  await expect(page.getByRole("textbox", { name: "محتوى المحاضرة الإضافية" })).toBeFocused();
  await page.getByRole("textbox", { name: "محتوى المحاضرة الإضافية" }).fill("امتداد شرح عملي");
  await page.getByRole("textbox", { name: "سبب تغيير العدد المعتمد" }).fill("الشرح يحتاج محاضرة كاملة إضافية");
  await page.getByRole("button", { name: "معاينة الأثر" }).click();
  await expect(page.getByRole("heading", { name: "أثر القرار قبل الاعتماد" })).toBeFocused();
  await expect(page.getByText("المحاضرات المعتمدة: ١ ← ٢", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "تأكيد اعتماد القرار" }).click();
  await expect(page.getByText("اعتمدت محاضرة كاملة إضافية", { exact: false })).toBeVisible();
  await expect(page.getByText("المحاضرات المعتمدة: ٢", { exact: false })).toBeVisible();
  await page.getByLabel("المحاضرة المعتمدة").selectOption("2");
  await page.getByLabel("موعد المحاضرة بتوقيت القاهرة").fill(localTime(45));
  await page.getByRole("button", { name: "معاينة المواعيد" }).click();
  await page.getByRole("button", { name: /تأكيد وحفظ/ }).click();
  await expect(page.getByRole("table")).toContainText("امتداد شرح عملي");
  await page.getByRole("row", { name: /امتداد شرح عملي/ }).getByRole("button", { name: "إلغاء نهائي وخفض العدد" }).click();
  await expect(page.getByRole("textbox", { name: "سبب تغيير العدد المعتمد" })).toBeFocused();
  await page.getByRole("textbox", { name: "سبب تغيير العدد المعتمد" }).fill("لن تعقد المحاضرة الإضافية نهائيًا");
  await page.getByRole("button", { name: "معاينة الأثر" }).click();
  await expect(page.getByText("المحاضرات المعتمدة: ٢ ← ١", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "تأكيد اعتماد القرار" }).click();
  await expect(page.getByText("اعتمد خفض عدد المحاضرات", { exact: false })).toBeVisible();
  await expect(page.getByText("المحاضرات المعتمدة: ١", { exact: false })).toBeVisible();
  const response = await page.request.get(`${origin}${apiPath}`);
  expect(Number(response.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  const members = await (await page.request.get(`${origin}/api/v1/center/member-workspace`)).json();
  const staffMember = members.members.find((member: { user: { email: string } }) => member.user.email === credentials.staff.email);
  expect(staffMember).toBeTruthy();
  expect((await write(page, `members/${staffMember.id}/grants`, { center_roles: [], branch_roles: { [branch.id]: ["branch_viewer"] } }, "PUT")).status).toBe(200);
  const viewer = await browser.newPage();
  try {
    await signIn(viewer, "staff");
    await viewer.goto(`${origin}${path}`);
    await expect(viewer.getByText("جدول المجموعة متاح للقراءة.")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "إلغاء الموعد" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "جدولة البديل" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "محاضرة إضافية" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "إلغاء نهائي وخفض العدد" })).toHaveCount(0);
    const denied = await viewer.request.get(`${origin}${apiPath}/${(await response.json()).sessions[0].id}/cancel-preview`);
    expect(denied.status()).toBe(403);
    const deniedRequirement = await write(viewer, `groups/${groupId}/requirements/preview`, {
      kind: "add", content: "محتوى جديد", reason: "اختبار صلاحيات التغيير",
    });
    expect(deniedRequirement.status).toBe(403);
  } finally { await viewer.close(); }
  await page.goto(`${origin}/admin/audit`);
  await expect(page.getByText("جدولة بديل لموعد ملغى").first()).toBeVisible();
  await expect(page.getByText("إلغاء موعد محاضرة قبل انعقادها").first()).toBeVisible();
  await expect(page.getByText("اعتماد تغيير عدد محاضرات المجموعة").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.getByRole("button", { name: "القائمة" }).click();
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "إغلاق القائمة" }).click();
  await page.goto(`${origin}${path}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

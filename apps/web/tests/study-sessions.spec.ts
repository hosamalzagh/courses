import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

test.skip(!process.env.COURSES_SESSIONS_CREDENTIALS, "Requires the disposable PostgreSQL center fixture.");
const origin = process.env.COURSES_SESSIONS_ORIGIN ?? "http://alpha.courses.test:8057";
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

async function write(page: Page, route: string, method: "POST" | "PUT", payload: object) {
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

test("schedule preview, confirmation, postponement and branch permissions through the employee UI", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    await signIn(staff, "staff");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north");
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south");
    const stamp = Date.now();
    const course = await write(owner, "courses", "POST", { branch_id: north.id, name: `جدولة ${stamp}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, "POST", { name: "مرحلة الجدولة", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, "POST", {
      name: "مستوى الجدولة", request_id: crypto.randomUUID(),
      lectures: Array.from({ length: 22 }, (_, index) => ({ number: index + 1, content: `محتوى ${index + 1}`, planned_hours: 2 })),
    });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", "POST", { name: `محاضر ${stamp}`, branch_ids: [north.id], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", "POST", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: `مجموعة الجدولة ${stamp}`, approved_price: "100.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(group.status).toBe(201);
    const path = `/admin/groups/${group.body.group.id}/sessions`;
    const apiPath = `/api/v1/center/groups/${group.body.group.id}/sessions`;
    const response = await owner.request.get(`${origin}${apiPath}`);
    expect(response.status()).toBe(200);
    expect(Number(response.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    const beforePage = reads().length;
    await owner.goto(`${origin}${path}`);
    await expect(owner.getByRole("heading", { name: new RegExp(`مجموعة الجدولة ${stamp}`) })).toBeVisible();
    if (queryLog) {
      const pageReads = reads().slice(beforePage).filter(item => item.path === apiPath);
      expect(pageReads).toHaveLength(1);
      expect(pageReads[0].count).toBeLessThanOrEqual(6);
    }
    const html = await (await owner.request.get(`${origin}${path}`)).text();
    expect(html).toContain(`مجموعة الجدولة ${stamp}`);
    const first = new Date(Date.now() + 15 * 86400000);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(first).replace(" ", "T");
    await owner.getByLabel("طريقة الإضافة").selectOption("weekly");
    await owner.getByRole("spinbutton", { name: "عدد المواعيد" }).fill("2");
    await owner.getByLabel("بداية أول موعد بتوقيت القاهرة").fill(local);
    await owner.getByRole("button", { name: "معاينة المواعيد" }).click();
    await expect(owner.getByRole("heading", { name: "تأكيد المواعيد" })).toBeFocused();
    await owner.getByRole("button", { name: "إلغاء المعاينة" }).click();
    await expect(owner.getByRole("button", { name: "معاينة المواعيد" })).toBeFocused();
    await owner.getByRole("button", { name: "معاينة المواعيد" }).click();
    await expect(owner.getByRole("heading", { name: "تأكيد المواعيد" }).locator("..")).toContainText("محاضرة الخطة ١");
    await owner.getByRole("button", { name: /تأكيد وحفظ ٢ موعد/ }).click();
    await expect(owner.getByText("حُفظت المواعيد وربطت بمحاضرات الخطة المعتمدة.")).toBeVisible();
    await expect(owner.getByRole("table").getByRole("row")).toHaveCount(3);
    await owner.getByRole("button", { name: "تأجيل" }).first().click();
    await expect(owner.getByLabel("الموعد الجديد بتوقيت القاهرة")).toBeFocused();
    const later = new Date(first.getTime() + 30 * 86400000);
    const laterLocal = new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(later).replace(" ", "T");
    await owner.getByLabel("الموعد الجديد بتوقيت القاهرة").fill(laterLocal);
    await owner.getByRole("textbox", { name: "سبب التأجيل (اختياري)" }).fill("تغيير القاعة");
    await owner.getByRole("button", { name: "حفظ التأجيل" }).click();
    await expect(owner.getByText("تأجل موعد المحاضرة؛ بقي رقمها ومحاضرة الخطة المرتبطة بها كما هما.")).toBeVisible();
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("تأجيل محاضرة مجموعة").first()).toBeVisible();
    await owner.getByText("عرض تغيير جدول المحاضرات").first().click();
    await expect(owner.getByText("تغيير القاعة").first()).toBeVisible();

    const next = new Date(first.getTime() + 60 * 86400000);
    const nextLocal = new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(next).replace(" ", "T");
    expect((await write(owner, `groups/${group.body.group.id}/sessions`, "POST", {
      kind: "weekly", revision: 3, start_at: nextLocal, count: 20, interval_weeks: 1, request_id: crypto.randomUUID(),
    })).status).toBe(201);
    await owner.goto(`${origin}${path}`);
    await expect(owner.getByText("غير المجدولة: ٠")).toBeVisible();
    const pages = owner.getByLabel("صفحات مواعيد المحاضرات");
    await pages.getByRole("button", { name: "الصفحة التالية في مواعيد المحاضرات" }).click();
    await pages.getByRole("link", { name: "الصفحة التالية في مواعيد المحاضرات" }).click();
    await expect(owner).toHaveURL(/\/sessions\?page=2/);
    await expect(owner.getByRole("table")).toContainText("محتوى 22");
    await expect(owner.getByRole("table").getByRole("row")).toHaveCount(3);

    const members = await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json();
    const membership = members.members.find((member: { user: { email: string } }) => member.user.email === credentials.staff.email);
    expect(membership).toBeTruthy();
    expect((await write(owner, `members/${membership.id}/grants`, "PUT", { center_roles: [], branch_roles: { [north.id]: ["branch_viewer"] } })).status).toBe(200);
    await staff.goto(`${origin}${path}`);
    await expect(staff.getByText("جدول المجموعة متاح للقراءة.")).toBeVisible();
    await expect(staff.getByRole("button", { name: "معاينة المواعيد" })).toHaveCount(0);
    expect((await staff.request.get(`${origin}/api/v1/center/groups/${group.body.group.id}/sessions`)).status()).toBe(200);
    expect((await write(staff, `groups/${group.body.group.id}/sessions/preview`, "POST", {
      kind: "single", revision: 3, start_at: local, plan_lecture_number: 3,
    })).status).toBe(403);
    const hidden = await write(owner, "courses", "POST", { branch_id: south.id, name: `مخفي ${stamp}`, request_id: crypto.randomUUID() });
    expect(hidden.status).toBe(201);
    const hiddenStage = await write(owner, `courses/${hidden.body.course.id}/stages`, "POST", { name: "مرحلة مخفية", request_id: crypto.randomUUID() });
    expect(hiddenStage.status).toBe(201);
    const hiddenLevel = await write(owner, `stages/${hiddenStage.body.stage.id}/levels`, "POST", {
      name: "مستوى مخفي", request_id: crypto.randomUUID(), lectures: [{ number: 1, content: "محتوى مخفي", planned_hours: 1 }],
    });
    expect(hiddenLevel.status).toBe(201);
    const hiddenInstructor = await write(owner, "instructors", "POST", { name: `محاضر مخفي ${stamp}`, branch_ids: [south.id], request_id: crypto.randomUUID() });
    expect(hiddenInstructor.status).toBe(201);
    const hiddenGroup = await write(owner, "groups", "POST", { level_id: hiddenLevel.body.level.id, plan_version_id: hiddenLevel.body.level.plan.id,
      name: `مجموعة مخفية ${stamp}`, approved_price: "0.00", instructor_ids: [hiddenInstructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(hiddenGroup.status).toBe(201);
    expect((await staff.request.get(`${origin}/api/v1/center/groups/${hiddenGroup.body.group.id}/sessions`)).status()).toBe(404);
    expect((await write(staff, `groups/${hiddenGroup.body.group.id}/sessions`, "POST", {
      kind: "single", revision: 1, start_at: local, plan_lecture_number: 1, request_id: crypto.randomUUID(),
    })).status).toBe(404);
    await staff.goto(`${origin}/admin/groups/${hiddenGroup.body.group.id}/sessions`);
    await expect(staff.getByText(`مجموعة مخفية ${stamp}`)).toHaveCount(0);
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.locator("html").getAttribute("dir")).toBe("rtl");
    await owner.getByRole("button", { name: "القائمة" }).click();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.getByRole("button", { name: "إغلاق القائمة" }).click();
    await owner.goto(`${origin}${path}`);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await owner.close(); await staff.close();
  }
});

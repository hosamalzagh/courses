import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

test.skip(!process.env.COURSES_PLAN_CREDENTIALS || !process.env.COURSES_PLAN_QUERY_LOG,
  "Requires the disposable plan-version center and SSR query log.");
test.setTimeout(120_000);
const origin = process.env.COURSES_PLAN_ORIGIN ?? "http://alpha.courses.test:8658";
const credentials = process.env.COURSES_PLAN_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_PLAN_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff") {
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
      method, credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json",
        "X-XSRF-TOKEN": decodeURIComponent(token ?? "") }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

function queryRows() {
  const path = process.env.COURSES_PLAN_QUERY_LOG!;
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { path: string; count: number | null }) : [];
}

test("plan versions preserve history, show their difference and enforce current branch authority", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const stamp = Date.now();
    const branch = await write(owner, "branches", { name: `فرع الإصدارات ${stamp}`, slug: `plans-${stamp}` });
    expect(branch.status).toBe(201);
    const branchId = branch.body.branch.id as number;
    const course = await write(owner, "courses", { branch_id: branchId, name: `كورس الإصدارات ${stamp}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "المرحلة الأولى", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, {
      name: "مستوى الإصدارات", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "الحروف", title: null, planned_hours: 2 }],
    });
    expect(level.status).toBe(201);
    const levelId = level.body.level.id as string;
    const firstPlan = level.body.level.plan as { id: string; revision: number };
    const pageUrl = `${origin}/admin/curriculum/${levelId}`;
    const before = queryRows().length;
    await owner.goto(pageUrl);
    await expect(owner.getByText("الحروف", { exact: true }).first()).toBeVisible();
    const reads = queryRows().slice(before).filter(row => row.path.startsWith("/api/v1/center/"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(row => Number.isInteger(row.count) && row.count! >= 0)).toBe(true);
    expect(reads.reduce((sum, row) => sum + row.count!, 0)).toBeLessThanOrEqual(6);
    await owner.getByRole("button", { name: "إنشاء إصدار جديد" }).click();
    await expect(owner.getByRole("textbox", { name: "محتوى المحاضرة 1" })).toBeFocused();
    await owner.getByRole("textbox", { name: "محتوى المحاضرة 1" }).fill("الكلمات");
    await owner.getByRole("textbox", { name: "عنوان المحاضرة 1 (اختياري)" }).fill("قراءة");
    await owner.getByRole("textbox", { name: "الساعات المخططة للمحاضرة 1" }).fill("3");
    await owner.getByRole("button", { name: "إضافة محاضرة كاملة" }).click();
    await owner.getByRole("textbox", { name: "محتوى المحاضرة 2" }).fill("جمل كاملة");
    const savedResponse = owner.waitForResponse(response => response.request().method() === "POST"
      && response.url().endsWith(`/levels/${levelId}/plan-versions`));
    await owner.getByRole("button", { name: "حفظ الإصدار الجديد" }).click();
    const saved = await savedResponse;
    expect(saved.status()).toBe(201);
    const secondPlan = (await saved.json()).plan as { id: string; version: number; revision: number };
    expect(secondPlan.version).toBe(2);
    await expect(owner.getByRole("heading", { name: "الاختلاف عن الإصدار ١" })).toBeVisible();
    await expect(owner.getByText("متطلبات معدّلة")).toBeVisible();
    await expect(owner.getByText("محاضرة مضافة")).toBeVisible();
    await expect(owner.getByRole("row", { name: /الإصدار ٢/ }).getByText("معروض")).toBeVisible();
    await owner.getByRole("row", { name: /الإصدار ١/ }).getByRole("link", { name: "عرض الإصدار" }).click();
    await expect(owner).toHaveURL(/plan_version=1/);
    await expect(owner.getByText("الحروف", { exact: true }).first()).toBeVisible();
    await expect(owner.getByText("الكلمات", { exact: true })).toHaveCount(0);
    await owner.getByRole("button", { name: "إنشاء إصدار جديد" }).click();
    await owner.getByRole("textbox", { name: "محتوى المحاضرة 1" }).fill("عبارات جديدة");
    const latestResponse = owner.waitForResponse(response => response.request().method() === "POST"
      && response.url().endsWith(`/levels/${levelId}/plan-versions`));
    await owner.getByRole("button", { name: "حفظ الإصدار الجديد" }).click();
    const latestPlan = (await (await latestResponse).json()).plan as { id: string; version: number; revision: number };
    expect(latestPlan.version).toBe(3);
    await expect(owner).toHaveURL(pageUrl);
    await expect(owner.getByText("عبارات جديدة", { exact: true }).first()).toBeVisible();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.setViewportSize({ width: 390, height: 844 });
    await expect(owner.getByText("متطلبات معدّلة")).toBeVisible();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const members = await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json();
    const membershipId = members.members.find((member: { user: { email: string } }) => member.user.email === credentials.staff.email)?.id;
    expect(membershipId).toBeTruthy();
    expect((await write(owner, `members/${membershipId}/grants`, { center_roles: [], branch_roles: { [branchId]: ["branch_viewer"] } }, "PUT")).status).toBe(200);
    await signIn(staff, "staff");
    await staff.goto(pageUrl);
    await expect(staff.getByText("عبارات جديدة", { exact: true }).first()).toBeVisible();
    await expect(staff.getByRole("button", { name: "إنشاء إصدار جديد" })).toHaveCount(0);
    const versionPath = `levels/${levelId}/plan-versions`;
    expect((await write(staff, versionPath, { base_plan_version_id: latestPlan.id, base_revision: latestPlan.revision,
      request_id: crypto.randomUUID(), lectures: [{ number: 1, content: "ممنوع", planned_hours: 1 }] })).status).toBe(403);
    expect((await write(owner, `members/${membershipId}/grants`, { center_roles: [], branch_roles: { [branchId]: ["academic_admin"] } }, "PUT")).status).toBe(200);
    await staff.reload();
    await staff.getByRole("button", { name: "إنشاء إصدار جديد" }).click();
    await staff.getByRole("textbox", { name: "محتوى المحاضرة 1" }).fill("مسودة بعد سحب الصلاحية");
    expect((await write(owner, `members/${membershipId}/grants`, { center_roles: [], branch_roles: {} }, "PUT")).status).toBe(200);
    await staff.getByRole("button", { name: "حفظ الإصدار الجديد" }).click();
    await expect(staff.getByRole("alert").filter({ hasText: "لم يعد متاحًا ضمن صلاحيتك" })).toBeVisible();
    const payload = { base_plan_version_id: latestPlan.id, base_revision: latestPlan.revision,
      lectures: [{ number: 1, content: "إصدار متزامن", planned_hours: 2 }] };
    const concurrent = await Promise.all([
      write(owner, versionPath, { ...payload, request_id: crypto.randomUUID() }),
      write(owner, versionPath, { ...payload, lectures: [{ number: 1, content: "إصدار منافس", planned_hours: 2 }], request_id: crypto.randomUUID() }),
    ]);
    expect(concurrent.map(result => result.status).sort()).toEqual([201, 409]);
    let currentPlan = concurrent.find(result => result.status === 201)!.body.plan as { id: string; revision: number };
    for (let version = 5; version <= 21; version++) {
      const next = await write(owner, versionPath, { base_plan_version_id: currentPlan.id,
        base_revision: currentPlan.revision, request_id: crypto.randomUUID(),
        lectures: [{ number: 1, content: `محتوى الإصدار ${version}`, planned_hours: 2 }] });
      expect(next.status).toBe(201);
      currentPlan = next.body.plan;
    }
    await owner.goto(pageUrl);
    const history = owner.getByRole("table", { name: "إصدارات خطة المستوى" });
    await owner.getByRole("button", { name: "الصفحة التالية في إصدارات خطة المستوى" }).click();
    await expect(history.getByRole("row", { name: /الإصدار ٢/ })).toBeVisible();
    await owner.getByRole("link", { name: "الدفعة التالية" }).click();
    await expect(owner).toHaveURL(/versions_page=2/);
    await expect(history.getByRole("row", { name: /الإصدار ١/ })).toBeVisible();
    await expect(owner.getByRole("button", { name: "الصفحة السابقة في إصدارات خطة المستوى" })).toBeDisabled();
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("إنشاء إصدار خطة المستوى").first()).toBeVisible();
    await owner.getByText("عرض تغيير المنهج").first().click();
    await expect(owner.getByText("إصدار الخطة:").first()).toBeVisible();
    expect((await owner.request.get(`${origin}/api/v1/center/levels/${levelId}?plan_version=1`)).status()).toBe(200);
    expect(firstPlan.id).not.toBe(secondPlan.id);
  } finally {
    await owner.close(); await staff.close();
  }
});

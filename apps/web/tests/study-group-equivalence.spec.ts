import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

test.skip(!process.env.COURSES_SESSIONS_CREDENTIALS, "Requires an isolated PostgreSQL center fixture.");
const origin = process.env.COURSES_SESSIONS_ORIGIN ?? "http://alpha.courses.test:8067";
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

test("approved group-added content equivalence is visible, reversible, scoped and responsive", async ({ page, browser }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branch = workspace.branches.find((item: { slug: string }) => item.slug === "north");
  const stamp = Date.now();
  const course = await write(page, "courses", { branch_id: branch.id, name: `تكافؤ مضاف ${stamp}`, request_id: crypto.randomUUID() });
  expect(course.status).toBe(201);
  const stage = await write(page, `courses/${course.body.course.id}/stages`, { name: "مرحلة", request_id: crypto.randomUUID() });
  expect(stage.status).toBe(201);
  const level = await write(page, `stages/${stage.body.stage.id}/levels`, {
    name: "مستوى", lectures: [{ number: 1, content: "أساس", planned_hours: 2 }], request_id: crypto.randomUUID(),
  });
  expect(level.status).toBe(201);
  const instructor = await write(page, "instructors", { name: `محاضر ${stamp}`, branch_ids: [branch.id], request_id: crypto.randomUUID() });
  expect(instructor.status).toBe(201);
  const groups = [];
  for (const suffix of ["المطلوبة", "البديلة"]) {
    const group = await write(page, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: `مجموعة ${suffix} ${stamp}`, approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(group.status).toBe(201);
    const route = `groups/${group.body.group.id}/requirements`;
    const change = { kind: "add", content: `محتوى ${suffix} ${stamp}`, reason: "إضافة محاضرة كاملة للمجموعة" };
    const preview = await write(page, `${route}/preview`, change);
    expect(preview.status).toBe(200);
    const added = await write(page, route, { ...change, group_revision: preview.body.group_revision,
      preview_token: preview.body.preview_token, request_id: crypto.randomUUID() });
    expect(added.status).toBe(201);
    groups.push({ id: group.body.group.id, requirement: added.body.requirement });
  }
  const requiredRoute = `groups/${groups[0].id}/requirements`;
  const another = { kind: "add", content: `متطلب آخر ${stamp}`, reason: "إضافة متطلب ثانٍ لاختبار تبديل البحث" };
  const anotherPreview = await write(page, `${requiredRoute}/preview`, another);
  expect(anotherPreview.status).toBe(200);
  const anotherRequirement = await write(page, requiredRoute, { ...another,
    group_revision: anotherPreview.body.group_revision, preview_token: anotherPreview.body.preview_token,
    request_id: crypto.randomUUID(),
  });
  expect(anotherRequirement.status).toBe(201);
  const path = `/admin/groups/${groups[0].id}/sessions`;
  const apiPath = `/api/v1/center/groups/${groups[0].id}/sessions`;
  const beforePage = reads().length;
  await page.goto(`${origin}${path}`);
  await expect(page.getByRole("button", { name: "تكافؤ المحاضرات المضافة" })).toBeVisible();
  if (queryLog) {
    const pageReads = reads().slice(beforePage).filter(item => item.path === apiPath);
    expect(pageReads).toHaveLength(1);
    expect(pageReads[0].count).toBeLessThanOrEqual(6);
  }
  await page.getByRole("button", { name: "تكافؤ المحاضرات المضافة" }).click();
  const optionsResponse = page.waitForResponse(response => response.url().includes("/requirement-equivalences/options"));
  await page.getByLabel("المتطلب المطلوب من هذه المجموعة").selectOption(groups[0].requirement.id);
  expect(Number((await optionsResponse).headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  await expect(page.getByRole("table", { name: "متطلبات المجموعات الأخرى" })).toContainText(`محتوى البديلة ${stamp}`);
  await page.getByRole("textbox", { name: "بحث عن المجموعة أو المحتوى المقابل" }).fill("لا نتائج مطابقة");
  await page.getByRole("button", { name: "بحث", exact: true }).click();
  await expect(page.getByText("لا توجد محاضرات مضافة مطابقة", { exact: false })).toBeVisible();
  await page.getByLabel("المتطلب المطلوب من هذه المجموعة").selectOption(anotherRequirement.body.requirement.id);
  await expect(page.getByRole("textbox", { name: "بحث عن المجموعة أو المحتوى المقابل" })).toHaveValue("");
  await expect(page.getByRole("table", { name: "متطلبات المجموعات الأخرى" })).toContainText(`محتوى البديلة ${stamp}`);
  await page.getByLabel("المتطلب المطلوب من هذه المجموعة").selectOption(groups[0].requirement.id);
  await expect(page.getByRole("table", { name: "متطلبات المجموعات الأخرى" })).toContainText(`محتوى البديلة ${stamp}`);
  await page.getByRole("textbox", { name: "سبب الاعتماد أو السحب" }).fill("اعتماد بديل أكاديمي للمحتوى المضاف");
  await page.getByRole("button", { name: "اعتماد التكافؤ" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("اعتماد بديل أكاديمي");
  await page.getByRole("button", { name: "اعتماد الربط" }).click();
  await expect(page.getByText("اعتمد تكافؤ المتطلبين وسُجل سببه.")).toBeVisible();
  await expect(page.getByRole("table", { name: "متطلبات المجموعات الأخرى" })).toContainText("معتمد");
  await page.getByRole("textbox", { name: "سبب الاعتماد أو السحب" }).fill("سحب الربط بعد مراجعة القرار");
  await page.getByRole("button", { name: "سحب الاعتماد" }).click();
  await page.getByRole("button", { name: "سحب الاعتماد", exact: true }).last().click();
  await expect(page.getByText("سُحب الاعتماد؛ سيُعاد حساب الرصيد دون هذا الربط.")).toBeVisible();
  await page.route(/\/requirement-equivalences\/options\?/, async route => {
    const requestedPage = Number(new URL(route.request().url()).searchParams.get("page"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      group_revision: 1, candidates: [], pagination: { page: requestedPage, has_more: requestedPage === 1 },
    }) });
  });
  await page.getByRole("button", { name: "بحث", exact: true }).click();
  await expect(page.getByRole("button", { name: "عرض المزيد" })).toBeVisible();
  await page.getByRole("textbox", { name: "بحث عن المجموعة أو المحتوى المقابل" }).fill("بحث لم يُطبّق بعد");
  const nextPageRequest = page.waitForRequest(request => request.url().includes("/requirement-equivalences/options?")
    && new URL(request.url()).searchParams.get("page") === "2");
  await page.getByRole("button", { name: "عرض المزيد" }).click();
  expect(new URL((await nextPageRequest).url()).searchParams.has("q")).toBe(false);
  await page.unroute(/\/requirement-equivalences\/options\?/);
  const members = await (await page.request.get(`${origin}/api/v1/center/member-workspace`)).json();
  const staff = members.members.find((item: { user: { email: string } }) => item.user.email === credentials.staff.email);
  expect((await write(page, `members/${staff.id}/grants`, {
    center_roles: [], branch_roles: { [branch.id]: ["branch_viewer"] },
  }, "PUT")).status).toBe(200);
  const viewer = await browser.newPage();
  try {
    await signIn(viewer, "staff");
    await viewer.goto(`${origin}${path}`);
    await expect(viewer.getByRole("button", { name: "تكافؤ المحاضرات المضافة" })).toHaveCount(0);
    const denied = await viewer.request.get(`${origin}/api/v1/center/groups/${groups[0].id}/requirement-equivalences/options?required_requirement_id=${groups[0].requirement.id}`);
    expect(denied.status()).toBe(403);
  } finally { await viewer.close(); }
  await page.goto(`${origin}/admin/audit`);
  await expect(page.getByText("اعتماد تكافؤ محاضرتين مضافتين").first()).toBeVisible();
  await expect(page.getByText("سحب تكافؤ محاضرتين مضافتين").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.getByRole("button", { name: "القائمة" }).click();
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "إغلاق القائمة" }).click();
  await page.goto(`${origin}${path}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

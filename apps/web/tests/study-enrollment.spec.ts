import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_ENROLLMENT_CREDENTIALS, "Requires the disposable PostgreSQL center fixture.");
const origin = process.env.COURSES_ENROLLMENT_ORIGIN ?? "http://alpha.courses.test:8057";
const credentials = process.env.COURSES_ENROLLMENT_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_ENROLLMENT_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff" = "alpha") {
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
      method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

async function group(page: Page, branchId: number, price: string) {
  const course = await write(page, "courses", { branch_id: branchId, name: `Course ${crypto.randomUUID().slice(0, 6)}`, request_id: crypto.randomUUID() });
  expect(course.status).toBe(201);
  const stage = await write(page, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
  expect(stage.status).toBe(201);
  const level = await write(page, `stages/${stage.body.stage.id}/levels`, {
    name: "Level", request_id: crypto.randomUUID(), lectures: [{ number: 1, content: "Required lecture", planned_hours: 2 }],
  });
  expect(level.status).toBe(201);
  const instructor = await write(page, "instructors", { name: `Teacher ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(instructor.status).toBe(201);
  const created = await write(page, "groups", {
    level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
    name: `Group ${crypto.randomUUID().slice(0, 6)}`, approved_price: price,
    instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID(),
  });
  expect(created.status).toBe(201);
  return created.body.group;
}

test("enrolls through the employee page and preserves SSR, credit, RTL, and the SQL budget", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id;
  const createdGroup = await group(page, branchId, "1500.00");
  const created = await write(page, "students", { name: `طالب تسجيل ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const studentId = created.body.student.id;
  const settings = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  const account = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  expect((await write(page, `students/${studentId}/payments`, {
    branch_id: branchId, method: "cash", received_on: "2026-09-28", amount: "500.00",
    version: account.account.version, request_id: crypto.randomUUID(),
  })).status).toBe(201);
  await page.goto(`${origin}/admin/students/${studentId}`);
  await page.getByRole("link", { name: "التسجيل ومحاولات الدراسة" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/students/${studentId}/enrollments$`));
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("500.00 EGP", { exact: true }).first()).toBeVisible();
  await page.getByRole("searchbox", { name: "بحث في المجموعات المتاحة للتسجيل" }).fill(createdGroup.name);
  await page.getByRole("button", { name: "بحث في جميع المجموعات المتاحة للتسجيل" }).click();
  await expect(page).toHaveURL(/q=Group/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("combobox", { name: "المجموعة الأساسية" }).selectOption(createdGroup.id);
  await page.getByRole("button", { name: "تسجيل الطالب والرسوم" }).click();
  await expect(page.getByLabel("تاريخ الانضمام الفعلي")).toBeFocused();
  await page.getByLabel("تاريخ الانضمام الفعلي").fill("2026-09-28");
  await page.getByLabel("الخصم").fill("200.00");
  await page.getByLabel("سبب الخصم").fill("منحة معتمدة");
  await page.getByRole("button", { name: "تسجيل الطالب والرسوم" }).click();
  await expect(page.getByText("سُجلت المحاولة ورسومها معًا", { exact: false })).toBeVisible();
  await expect(page.getByText("1300.00 EGP").first()).toBeVisible();
  const response = await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`);
  expect(Number(response.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  const body = await response.json();
  expect(body.attempts).toHaveLength(1);
  expect(body.balance).toMatchObject({ available_credit: "500.00", debt: "1300.00" });
  expect(body.attempts[0].requirements_count).toBe(1);
  const html = await page.request.get(`${origin}/admin/students/${studentId}/enrollments`);
  expect(await html.text()).toContain("1300.00");
  await page.goto(`${origin}/admin/students/${studentId}/account`);
  await expect(page.getByText("مديونية محاولات الدراسة ضمن فروع صلاحيتك", { exact: false })).toBeVisible();
  await expect(page.getByText("1300.00 EGP").first()).toBeVisible();
  await page.goto(`${origin}/admin/students/${studentId}/enrollments`);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.getByRole("button", { name: "القائمة" }).click();
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "إغلاق القائمة" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`${origin}/admin/audit`);
  await expect(page.getByText("تسجيل طالب ورسوم محاولة الدراسة").first()).toBeVisible();
  await page.getByText("تفاصيل محاولة الدراسة ورسومها").first().click();
  await expect(page.getByText("منحة معتمدة").first()).toBeVisible();
});

test("restricted registration staff cannot see another branch or enroll its student", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((item: { slug: string }) => item.slug === "north");
    const south = workspace.branches.find((item: { slug: string }) => item.slug === "south");
    const hiddenGroup = await group(owner, south.id, "100.00");
    const shared = await write(owner, "students", { name: `مشترك ${Date.now()}`, branch_ids: [north.id, south.id], request_id: crypto.randomUUID() });
    const hidden = await write(owner, "students", { name: `محجوب ${Date.now()}`, branch_ids: [south.id], request_id: crypto.randomUUID() });
    expect(shared.status).toBe(201); expect(hidden.status).toBe(201);
    expect((await write(owner, `members/${credentials.staff.membership_id}/grants`, { center_roles: [], branch_roles: { [north.id]: ["registration"] } }, "PUT")).status).toBe(200);
    await signIn(staff, "staff");
    await staff.goto(`${origin}/admin/students/${shared.body.student.id}/enrollments`);
    expect(await staff.locator("body").innerText()).not.toContain(hiddenGroup.name);
    const visible = await staff.request.get(`${origin}/api/v1/center/students/${shared.body.student.id}/enrollments`);
    expect(Number(visible.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    expect((await visible.json()).groups).not.toContainEqual(expect.objectContaining({ id: hiddenGroup.id }));
    await staff.goto(`${origin}/admin/students/${hidden.body.student.id}/enrollments`);
    await expect(staff.getByRole("heading", { name: "ملف الطالب غير متاح" })).toBeVisible();
    expect((await staff.request.get(`${origin}/api/v1/center/students/${hidden.body.student.id}/enrollments`)).status()).toBe(404);
  } finally { await owner.close(); await staff.close(); }
});

test("simultaneous submissions keep one fee per request and reject stale distinct requests", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id;
  const first = await group(page, branchId, "80.00");
  const second = await group(page, branchId, "40.00");
  const created = await write(page, "students", { name: `تزامن التسجيل ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const studentId = created.body.student.id;
  const settings = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  const enrollment = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  await page.evaluate(() => fetch("/sanctum/csrf-cookie", { credentials: "same-origin" }));
  const xsrf = (await page.context().cookies(origin)).find(cookie => cookie.name === "XSRF-TOKEN")?.value ?? "";
  const payload = { group_id: first.id, group_revision: first.revision, currency_revision: enrollment.student.currency_revision, joined_on: "2026-09-28", discount: "0.00", discount_reason: null,
    version: enrollment.student.version, request_id: crypto.randomUUID() };
  const post = async (port: number, data: object) => {
    const response = await page.request.post(`http://alpha.courses.test:${port}/api/v1/center/students/${studentId}/enrollments`, {
      data, headers: { Accept: "application/json", "X-XSRF-TOKEN": decodeURIComponent(xsrf) },
    });
    return { status: response.status(), body: await response.json() };
  };
  const same = await Promise.all([post(8157, payload), post(8158, payload)]);
  expect(same.map(item => item.status).sort()).toEqual([200, 201]);
  expect(same[0].body.attempt.id).toBe(same[1].body.attempt.id);
  const after = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  expect(after.attempts).toHaveLength(1);
  expect(after.balance.debt).toBe("80.00");
  const distinct = await Promise.all([0, 1].map(index => post(index ? 8158 : 8157, {
    ...payload, group_id: second.id, group_revision: second.revision, version: after.student.version, request_id: crypto.randomUUID(),
  })));
  expect(distinct.map(item => item.status).sort()).toEqual([201, 409]);
  const final = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  expect(final.attempts).toHaveLength(2);
  expect(final.balance.debt).toBe("120.00");
});

test("a lost enrollment response retries the original request without another fee", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id;
  const createdGroup = await group(page, branchId, "30.00");
  const created = await write(page, "students", { name: `استجابة تسجيل ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const studentId = created.body.student.id;
  const settings = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  await page.goto(`${origin}/admin/students/${studentId}/enrollments`);
  await page.getByRole("combobox", { name: "المجموعة الأساسية" }).selectOption(createdGroup.id);
  await page.getByLabel("تاريخ الانضمام الفعلي").fill("2026-09-28");
  await page.route(`**/api/v1/center/students/${studentId}/enrollments`, async route => {
    await route.fetch();
    await route.abort("failed");
    await page.unroute(`**/api/v1/center/students/${studentId}/enrollments`);
  });
  await page.getByRole("button", { name: "تسجيل الطالب والرسوم" }).click();
  await expect(page.getByRole("button", { name: "إلغاء البيانات" })).toBeDisabled();
  await page.getByRole("button", { name: "التحقق من التسجيل" }).click();
  await expect(page.getByText("سُجلت المحاولة ورسومها معًا", { exact: false })).toBeVisible();
  const saved = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  expect(saved.attempts).toHaveLength(1);
  expect(saved.balance.debt).toBe("30.00");
});

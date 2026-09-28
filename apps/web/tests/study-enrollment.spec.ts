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
  await page.getByRole("searchbox", { name: "بحث في المجموعات المتاحة للتسجيل" }).fill("مجموعة أخرى");
  await page.getByRole("button", { name: "بحث في جميع المجموعات المتاحة للتسجيل" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("بيانات تسجيل لم تُحفظ");
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "المجموعة الأساسية" })).toHaveValue(createdGroup.id);
  await expect(page.getByLabel("سبب الخصم")).toHaveValue("منحة معتمدة");
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

test("suspension blocks a stale enrollment preview and lifting allows registration", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id;
  const createdGroup = await group(page, branchId, "150.00");
  const created = await write(page, "students", { name: `طالب منع التسجيل ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const studentId = created.body.student.id;
  const settings = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  await page.goto(`${origin}/admin/students/${studentId}/enrollments`);
  await page.getByRole("searchbox", { name: "بحث في المجموعات المتاحة للتسجيل" }).fill(createdGroup.name);
  await page.getByRole("button", { name: "بحث في جميع المجموعات المتاحة للتسجيل" }).click();
  await expect(page).toHaveURL(/q=Group/);
  await page.getByRole("combobox", { name: "المجموعة الأساسية" }).selectOption(createdGroup.id);
  await page.getByLabel("تاريخ الانضمام الفعلي").fill("2026-09-28");
  const suspended = await write(page, `students/${studentId}/status`, {
    status: "suspended", reason: "إيقاف قبل التأكيد", status_revision: 1, request_id: crypto.randomUUID(),
  });
  expect(suspended.status).toBe(200);
  await page.getByRole("button", { name: "تسجيل الطالب والرسوم" }).click();
  await expect(page.getByText("أُوقف ملف الطالب بعد فتح الصفحة", { exact: false })).toBeVisible();
  const deniedResponse = await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`);
  expect(Number(deniedResponse.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  const denied = await deniedResponse.json();
  expect(denied.attempts).toHaveLength(0);
  expect(denied.balance.debt).toBe("0");
  await page.getByRole("button", { name: "تحميل أحدث البيانات" }).click();
  await expect(page.getByText("الطالب موقوف؛ لا يمكن تسجيل محاولة جديدة.")).toBeVisible();
  await expect(page.getByRole("button", { name: "تسجيل الطالب والرسوم" })).toBeDisabled();
  const lifted = await write(page, `students/${studentId}/status`, {
    status: "active", reason: "انتهاء الإيقاف", status_revision: suspended.body.status_revision, request_id: crypto.randomUUID(),
  });
  expect(lifted.status).toBe(200);
  await page.reload();
  await expect(page.getByRole("button", { name: "تسجيل الطالب والرسوم" })).toBeEnabled();
  await page.getByRole("combobox", { name: "المجموعة الأساسية" }).selectOption(createdGroup.id);
  await page.getByLabel("تاريخ الانضمام الفعلي").fill("2026-09-28");
  await page.getByRole("button", { name: "تسجيل الطالب والرسوم" }).click();
  await expect(page.getByText("سُجلت المحاولة ورسومها معًا", { exact: false })).toBeVisible();
  const after = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  expect(after.attempts).toHaveLength(1);
  expect(after.balance.debt).toBe("150.00");
});

test("parallel suspension and enrollment produce one serialized decision", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id;
  const createdGroup = await group(page, branchId, "80.00");
  const created = await write(page, "students", { name: `تزامن الإيقاف ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const studentId = created.body.student.id;
  const settings = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  const preview = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  await page.evaluate(() => fetch("/sanctum/csrf-cookie", { credentials: "same-origin" }));
  const xsrf = (await page.context().cookies(origin)).find(cookie => cookie.name === "XSRF-TOKEN")?.value ?? "";
  const headers = { Accept: "application/json", "X-XSRF-TOKEN": decodeURIComponent(xsrf) };
  const statusUrl = `http://alpha.courses.test:8157/api/v1/center/students/${studentId}/status`;
  const enrollmentUrl = `http://alpha.courses.test:8158/api/v1/center/students/${studentId}/enrollments`;
  const [suspension, enrollment] = await Promise.all([
    page.request.post(statusUrl, { headers, data: { status: "suspended", reason: "قرار متزامن", status_revision: 1, request_id: crypto.randomUUID() } }),
    page.request.post(enrollmentUrl, { headers, data: { group_id: createdGroup.id, group_revision: createdGroup.revision,
      currency_revision: preview.student.currency_revision, joined_on: "2026-09-28", discount: "0.00", discount_reason: null,
      version: preview.student.version, request_id: crypto.randomUUID() } }),
  ]);
  expect(suspension.status()).toBe(200);
  expect([201, 409]).toContain(enrollment.status());
  if (enrollment.status() === 409) expect((await enrollment.json()).code).toBe("student_suspended");
  const after = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  expect(after.student.status).toBe("suspended");
  expect(after.attempts).toHaveLength(enrollment.status() === 201 ? 1 : 0);
  expect(after.balance.debt).toBe(enrollment.status() === 201 ? "80.00" : "0");
  if (enrollment.status() === 201) expect(after.attempts[0].fee.net_amount).toBe("80.00");
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
  await page.getByRole("searchbox", { name: "بحث في المجموعات المتاحة للتسجيل" }).fill(createdGroup.name);
  await page.getByRole("button", { name: "بحث في جميع المجموعات المتاحة للتسجيل" }).click();
  await expect(page).toHaveURL(/q=Group/);
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

test("registration note stays on its event with version history and importance", async ({ page, browser }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id;
  const createdGroup = await group(page, branchId, "120.00");
  const created = await write(page, "students", { name: `ملاحظة تسجيل ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(created.status).toBe(201);
  const studentId = created.body.student.id;
  const settings = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  const preview = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  const enrolled = await write(page, `students/${studentId}/enrollments`, {
    group_id: createdGroup.id, group_revision: createdGroup.revision, currency_revision: preview.student.currency_revision,
    joined_on: "2026-09-28", discount: "0.00", discount_reason: null, version: preview.student.version, request_id: crypto.randomUUID(),
  });
  expect(enrolled.status).toBe(201);
  const attemptId = enrolled.body.attempt.id;
  await page.goto(`${origin}/admin/students/${studentId}/enrollments`);
  await page.getByRole("button", { name: "إضافة ملاحظة" }).click();
  await expect(page.getByRole("heading", { name: `ملاحظة تسجيل ${createdGroup.name}` })).toBeVisible();
  await page.getByRole("textbox", { name: "نص الملاحظة" }).fill("متابعة موعد المجموعة");
  await page.getByRole("searchbox", { name: "بحث في محاولات الدراسة" }).fill("لا توجد نتيجة");
  await expect(page.getByRole("textbox", { name: "نص الملاحظة" })).toHaveValue("متابعة موعد المجموعة");
  await page.getByRole("searchbox", { name: "بحث في محاولات الدراسة" }).fill("");
  await page.getByRole("checkbox", { name: "ملاحظة مهمة" }).check();
  await page.getByRole("button", { name: "إضافة الملاحظة" }).click();
  await expect(page.getByText("حُفظت الملاحظة ونسخة تعديلها", { exact: false })).toBeVisible();
  await expect(page.getByText("نسخة ١", { exact: false })).toBeVisible();
  await page.getByRole("textbox", { name: "نص الملاحظة" }).fill("موعد جديد بموافقة الطالب");
  await page.route(`**/api/v1/center/students/${studentId}/enrollments/${attemptId}/note`, async route => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    await route.fetch();
    await route.abort("failed");
    await page.unroute(`**/api/v1/center/students/${studentId}/enrollments/${attemptId}/note`);
  });
  await page.getByRole("button", { name: "حفظ تعديل الملاحظة" }).click();
  await expect(page.getByRole("button", { name: "التحقق من الحفظ" })).toBeVisible();
  await page.getByRole("button", { name: "التحقق من الحفظ" }).click();
  await expect(page.getByText("نسخة ٢", { exact: false })).toBeVisible();
  await page.getByRole("checkbox", { name: "ملاحظة مهمة" }).uncheck();
  await page.getByRole("button", { name: "حفظ تعديل الملاحظة" }).click();
  await expect(page.getByText("نسخة ٣", { exact: false })).toBeVisible();
  const noteResponse = await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments/${attemptId}/note`);
  expect(Number(noteResponse.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  const note = await noteResponse.json();
  expect(note.note).toMatchObject({ body: "موعد جديد بموافقة الطالب", important: false, revision: 3 });
  expect(note.versions).toHaveLength(3);
  const after = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  expect(after.attempts[0]).toMatchObject({ id: attemptId, note: { revision: 3, important: false }, fee: { net_amount: "120.00" } });
  await page.getByRole("textbox", { name: "نص الملاحظة" }).fill("مسودة الموظف بعد التعارض");
  expect((await write(page, `students/${studentId}/enrollments/${attemptId}/note`, {
    body: "تعديل متزامن", important: false, revision: 3, request_id: crypto.randomUUID(),
  }, "PUT")).status).toBe(200);
  await page.getByRole("button", { name: "حفظ تعديل الملاحظة" }).click();
  await expect(page.getByText("تغيرت الملاحظة منذ فتحها", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "تحميل أحدث نسخة" }).click();
  await expect(page.getByRole("textbox", { name: "نص الملاحظة" })).toHaveValue("مسودة الموظف بعد التعارض");
  await expect(page.getByText("تعديل متزامن").first()).toBeVisible();
  await page.route(`**/api/v1/center/students/${studentId}/enrollments/${attemptId}/note`, async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.abort("failed");
    await page.unroute(`**/api/v1/center/students/${studentId}/enrollments/${attemptId}/note`);
  });
  await page.getByRole("button", { name: "حفظ تعديل الملاحظة" }).click();
  await expect(page.getByText("حُفظت الملاحظة، لكن تعذر تحديث تاريخ النسخ", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "التحقق من الحفظ" })).toHaveCount(0);
  expect((await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments/${attemptId}/note`)).json()).note.revision).toBe(5);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.getByRole("button", { name: "القائمة" }).click();
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "إغلاق القائمة" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(page.getByRole("button", { name: "عرض/تعديل الملاحظة" })).toBeFocused();
  const profileHtml = await page.goto(`${origin}/admin/students/${studentId}?tab=enrollment-notes`);
  expect(await profileHtml!.text()).toContain("مسودة الموظف بعد التعارض");
  await expect(page.getByRole("heading", { name: "ملاحظات التسجيل الدراسي" })).toBeVisible();
  await expect(page.getByText("مسودة الموظف بعد التعارض").first()).toBeVisible();
  await page.getByRole("button", { name: "عرض تاريخ التعديل" }).click();
  await expect(page.getByRole("heading", { name: `تاريخ ملاحظة ${createdGroup.name}` })).toBeVisible();
  await expect(page.getByText("نسخة ٥", { exact: false })).toBeVisible();
  await page.goto(`${origin}/admin/audit`);
  await expect(page.getByText("تعديل ملاحظة تسجيل الطالب").first()).toBeVisible();
  await page.getByText("تفاصيل ملاحظة التسجيل").first().click();
  await expect(page.getByText(`المحاولة: ${attemptId}`, { exact: false }).first()).toBeVisible();
  await expect(page.getByText("موعد جديد بموافقة الطالب")).toHaveCount(0);
  expect((await write(page, `members/${credentials.staff.membership_id}/grants`, {
    center_roles: [], branch_roles: { [branchId]: ["branch_viewer"] },
  }, "PUT")).status).toBe(200);
  const viewer = await browser.newPage();
  try {
    await signIn(viewer, "staff");
    await viewer.goto(`${origin}/admin/students/${studentId}`);
    await viewer.getByRole("link", { name: "ملاحظات التسجيل" }).click();
    await expect(viewer.getByText("مسودة الموظف بعد التعارض").first()).toBeVisible();
    await viewer.getByRole("button", { name: "عرض تاريخ التعديل" }).click();
    await expect(viewer.getByText("نسخة ٥", { exact: false })).toBeVisible();
    await expect(viewer.getByRole("link", { name: "التسجيل ومحاولات الدراسة" })).toHaveCount(0);
    await expect(viewer.getByText("120.00 EGP")).toHaveCount(0);
  } finally { await viewer.close(); }
});

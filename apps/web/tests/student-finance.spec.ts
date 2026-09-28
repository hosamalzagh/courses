import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_FINANCE_CREDENTIALS, "Requires the disposable PostgreSQL center fixture.");
const origin = process.env.COURSES_FINANCE_ORIGIN ?? "http://alpha.courses.test:8057";
const credentials = process.env.COURSES_FINANCE_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_FINANCE_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "staff" = "alpha") {
  await page.goto(`${origin}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials[who].password);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, route: string, payload: object, method = "POST") {
  return page.evaluate(async ({ route, payload, method }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find((part) => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

async function pricedGroup(page: Page, branchId: number) {
  const course = await write(page, "courses", { branch_id: branchId, name: `Course ${crypto.randomUUID().slice(0, 6)}`, request_id: crypto.randomUUID() });
  expect(course.status).toBe(201);
  const stage = await write(page, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
  expect(stage.status).toBe(201);
  const level = await write(page, `stages/${stage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(), lectures: [{ number: 1, content: "Required lecture", planned_hours: 2 }] });
  expect(level.status).toBe(201);
  const instructor = await write(page, "instructors", { name: `Teacher ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(instructor.status).toBe(201);
  const group = await write(page, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
    name: `Group ${crypto.randomUUID().slice(0, 6)}`, approved_price: "100.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
  expect(group.status).toBe(201);
  return group.body.group;
}

test("allocates a payment, reverses it with a reason, and updates the visible balances", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id;
  const group = await pricedGroup(page, branchId);
  const student = await write(page, "students", { name: `تخصيص ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(student.status).toBe(201);
  const studentId = student.body.student.id;
  const accountPath = `students/${studentId}/account`;
  const settings = await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  const enrollment = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
  expect((await write(page, `students/${studentId}/enrollments`, { group_id: group.id, group_revision: group.revision,
    currency_revision: enrollment.student.currency_revision, joined_on: "2026-09-28", discount: "0.00", discount_reason: null,
    version: enrollment.student.version, request_id: crypto.randomUUID() })).status).toBe(201);
  const before = await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
  expect((await write(page, `students/${studentId}/payments`, { branch_id: branchId, method: "cash", received_on: "2026-09-28",
    amount: "80.00", version: before.account.version, request_id: crypto.randomUUID() })).status).toBe(201);
  await page.goto(`${origin}/admin/students/${studentId}/account`);
  await expect(page.getByText("80.00 EGP").first()).toBeVisible();
  await page.getByRole("button", { name: "عرض وتخصيص" }).click();
  await expect(page.getByRole("heading", { name: /تخصيص الدفعة المستلمة/ })).toBeVisible();
  const optionsResponse = await page.request.get(`${origin}/api/v1/center/students/${studentId}/payments/${(await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json()).payments[0].id}/allocation-options`);
  expect(Number(optionsResponse.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  await page.getByLabel(new RegExp(`المستحق 100.00.*المتبقي 100.00`)).fill("60.00");
  await page.getByRole("button", { name: "تخصيص المبالغ المحددة" }).click();
  await expect(page.getByText("حُفظ التخصيص", { exact: false })).toBeVisible();
  await expect(page.getByText("20.00 EGP").first()).toBeVisible();
  const allocated = await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
  expect(allocated.account).toMatchObject({ available_balance: "20.00", paid_total: "60.00", debt: "40.00" });
  await page.getByRole("button", { name: "عكس التخصيص" }).click();
  await page.getByLabel("سبب العكس").fill("سجل على المجموعة خطأ");
  await page.getByRole("button", { name: "اعتماد العكس" }).click();
  await expect(page.getByText("سُجل عكس التخصيص", { exact: false })).toBeVisible();
  const reversed = await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
  expect(reversed.account).toMatchObject({ available_balance: "80.00", paid_total: "0.00", debt: "100.00" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.getByRole("button", { name: "القائمة" }).click();
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "إغلاق القائمة" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("simultaneous allocations cannot spend one payment twice", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id;
  const groups = [await pricedGroup(page, branchId), await pricedGroup(page, branchId)];
  const student = await write(page, "students", { name: `تزامن تخصيص ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(student.status).toBe(201);
  const studentId = student.body.student.id;
  const accountPath = `students/${studentId}/account`;
  const settings = await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  const attempts: string[] = [];
  for (const group of groups) {
    const current = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
    const created = await write(page, `students/${studentId}/enrollments`, { group_id: group.id, group_revision: group.revision,
      currency_revision: current.student.currency_revision, joined_on: "2026-09-28", discount: "0.00", discount_reason: null,
      version: current.student.version, request_id: crypto.randomUUID() });
    expect(created.status).toBe(201);
    attempts.push(created.body.attempt.id);
  }
  const before = await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
  const payment = await write(page, `students/${studentId}/payments`, { branch_id: branchId, method: "cash", received_on: "2026-09-28",
    amount: "100.00", version: before.account.version, request_id: crypto.randomUUID() });
  expect(payment.status).toBe(201);
  const version = (await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json()).account.version;
  await page.evaluate(() => fetch("/sanctum/csrf-cookie", { credentials: "same-origin" }));
  const xsrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === "XSRF-TOKEN")?.value ?? "";
  const outcomes = await Promise.all([8157, 8158].map(async (port, index) => {
    const response = await page.request.post(`http://alpha.courses.test:${port}/api/v1/center/students/${studentId}/payments/${payment.body.payment.id}/allocations`, {
      data: { targets: [{ attempt_id: attempts[index], amount: "80.00" }], version, request_id: crypto.randomUUID() },
      headers: { Accept: "application/json", "X-XSRF-TOKEN": decodeURIComponent(xsrf) },
    });
    return { status: response.status(), body: await response.json() };
  }));
  expect(outcomes.map((item) => item.status).sort()).toEqual([201, 409]);
  expect(outcomes.find((item) => item.status === 409)?.body.code).toBe("student_account_changed");
  const after = await (await page.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
  expect(after.account).toMatchObject({ available_balance: "20.00", paid_total: "80.00", debt: "120.00" });
  expect(after.payments[0].allocated_amount).toBe("80.00");
});

test("currency, payment and visible account work through the employee UI and SSR", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const student = await write(page, "students", {
    name: `حساب تجريبي ${Date.now()}`, branch_ids: [workspace.branches[0].id], request_id: crypto.randomUUID(),
  });
  expect(student.status).toBe(201);
  const studentId = student.body.student.id;
  await page.goto(`${origin}/admin/students/${studentId}`);
  await page.getByRole("link", { name: "الحساب المالي" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/students/${studentId}/account$`));
  await expect(page.getByText("الرصيد غير المخصص", { exact: false })).toBeVisible();
  if (await page.getByRole("combobox", { name: "عملة المركز" }).count()) {
    await page.getByRole("combobox", { name: "عملة المركز" }).selectOption("EGP");
    if (await page.getByRole("button", { name: "حفظ عملة المركز" }).isEnabled()) {
      await page.getByRole("button", { name: "حفظ عملة المركز" }).click();
      await expect(page.getByText("حُفظت عملة المركز.", { exact: false })).toBeVisible();
    }
  } else await expect(page.getByText("عملة المركز ثابتة بعد أول حركة", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "تسجيل الدفعة" }).click();
  await expect(page.getByLabel("تاريخ الاستلام")).toBeFocused();
  await page.getByLabel("تاريخ الاستلام").fill("2026-09-28");
  await page.getByLabel("المبلغ (EGP)").fill("120.50");
  await page.getByRole("button", { name: "تسجيل الدفعة" }).click();
  await expect(page.getByText("سُجلت الدفعة المقدمة", { exact: false })).toBeVisible();
  await expect(page.getByText("120.50 EGP").first()).toBeVisible();
  await expect(page.getByText("عملة المركز ثابتة بعد أول حركة", { exact: false })).toBeVisible();
  const account = await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`);
  expect(Number(account.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  expect(await account.text()).toContain("120.50");
  const html = await page.request.get(`${origin}/admin/students/${studentId}/account`);
  expect(await html.text()).toContain("120.50");
  await page.getByRole("searchbox", { name: "بحث في حركات الدفعات المقدمة" }).fill("120.50");
  await page.getByRole("button", { name: "بحث في جميع حركات الدفعات المقدمة" }).click();
  await expect(page).toHaveURL(/q=120.50/);
  await expect(page.getByText("120.50 EGP").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.getByRole("button", { name: "القائمة" }).click();
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "إغلاق القائمة" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`${origin}/admin/audit`);
  await expect(page.getByText("استلام دفعة مقدمة للطالب").first()).toBeVisible();
  await page.getByText("تفاصيل الدفعة المقدمة").first().click();
  await expect(page.getByText("120.50 EGP").first()).toBeVisible();
});

test("restricted staff see only their branch and a hidden account is denied in the browser", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((item: { slug: string }) => item.slug === "north");
    const south = workspace.branches.find((item: { slug: string }) => item.slug === "south");
    const shared = await write(owner, "students", { name: `فرعان ${Date.now()}`, branch_ids: [north.id, south.id], request_id: crypto.randomUUID() });
    const hidden = await write(owner, "students", { name: `جنوب فقط ${Date.now()}`, branch_ids: [south.id], request_id: crypto.randomUUID() });
    expect(shared.status).toBe(201); expect(hidden.status).toBe(201);
    const studentId = shared.body.student.id;
    const settings = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
    if (!settings.account.currency) expect((await write(owner, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
    let southPaymentId = "";
    for (const [branchId, amount] of [[north.id, "25.00"], [south.id, "80.00"]] as const) {
      const account = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
      const saved = await write(owner, `students/${studentId}/payments`, { branch_id: branchId, method: "cash", received_on: "2026-09-28", amount, version: account.account.version, request_id: crypto.randomUUID() });
      expect(saved.status).toBe(201);
      if (branchId === south.id) southPaymentId = saved.body.payment.id;
    }
    const members = await (await owner.request.get(`${origin}/api/v1/center/member-workspace`)).json();
    const staffMembershipId = members.members.find((item: { user: { email: string } }) => item.user.email === credentials.staff.email)?.id;
    expect(staffMembershipId).toBeTruthy();
    expect((await write(owner, `members/${staffMembershipId}/grants`, { center_roles: [], branch_roles: { [north.id]: ["accounting"] } }, "PUT")).status).toBe(200);
    await signIn(staff, "staff");
    await staff.goto(`${origin}/admin/students/${studentId}/account`);
    await expect(staff.getByText("25.00 EGP").first()).toBeVisible();
    expect(await staff.locator("body").innerText()).not.toContain("80.00");
    expect((await staff.request.get(`${origin}/api/v1/center/students/${studentId}/payments/${southPaymentId}/allocation-options`)).status()).toBe(404);
    const visible = await staff.request.get(`${origin}/api/v1/center/students/${studentId}/account`);
    expect((await visible.json()).account).not.toHaveProperty("revision");
    await staff.goto(`${origin}/admin/students/${hidden.body.student.id}/account`);
    await expect(staff.getByRole("heading", { name: "ملف الطالب غير متاح" })).toBeVisible();
    expect((await staff.request.get(`${origin}/api/v1/center/students/${hidden.body.student.id}/account`)).status()).toBe(404);
  } finally { await owner.close(); await staff.close(); }
});

test("simultaneous real HTTP retries save one payment", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const student = await write(page, "students", { name: `تزامن ${Date.now()}`, branch_ids: [workspace.branches[0].id], request_id: crypto.randomUUID() });
  expect(student.status).toBe(201);
  const studentId = student.body.student.id;
  const settings = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  if (!settings.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: settings.account.currency_revision }, "PATCH")).status).toBe(200);
  await page.evaluate(() => fetch("/sanctum/csrf-cookie", { credentials: "same-origin" }));
  const xsrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === "XSRF-TOKEN")?.value ?? "";
  const request = { branch_id: workspace.branches[0].id, method: "cash", received_on: "2026-09-28", amount: "17.25", version: settings.account.version, request_id: crypto.randomUUID() };
  const outcomes = await Promise.all([8157, 8158].map(async (port) => {
    const response = await page.request.post(`http://alpha.courses.test:${port}/api/v1/center/students/${studentId}/payments`, {
      data: request, headers: { Accept: "application/json", "X-XSRF-TOKEN": decodeURIComponent(xsrf) },
    });
    return { status: response.status(), body: await response.json() };
  }));
  expect(outcomes.map((item) => item.status).sort()).toEqual([200, 201]);
  expect(outcomes[0].body.payment.id).toBe(outcomes[1].body.payment.id);
  const account = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  expect(account.account.available_balance).toBe("17.25");
  expect(account.payments).toHaveLength(1);
  const distinct = await Promise.all([8157, 8158].map(async (port, index) => {
    const response = await page.request.post(`http://alpha.courses.test:${port}/api/v1/center/students/${studentId}/payments`, {
      data: { ...request, version: account.account.version, amount: index === 0 ? "5.00" : "7.00", request_id: crypto.randomUUID() },
      headers: { Accept: "application/json", "X-XSRF-TOKEN": decodeURIComponent(xsrf) },
    });
    return { status: response.status(), body: await response.json() };
  }));
  expect(distinct.map((item) => item.status).sort()).toEqual([201, 409]);
  expect(distinct.find((item) => item.status === 409)?.body.code).toBe("student_account_changed");
  const after = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  expect(after.payments).toHaveLength(2);
  expect(after.account.available_balance).toBe(distinct[0].status === 201 ? "22.25" : "24.25");
});

test("lost payment response keeps the same request until a safe retry", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const student = await write(page, "students", { name: `استجابة مفقودة ${Date.now()}`, branch_ids: [workspace.branches[0].id], request_id: crypto.randomUUID() });
  expect(student.status).toBe(201);
  const studentId = student.body.student.id;
  const account = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  if (!account.account.currency) expect((await write(page, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
  await page.goto(`${origin}/admin/students/${studentId}/account`);
  await page.getByLabel("تاريخ الاستلام").fill("2026-09-28");
  await page.getByLabel("المبلغ (EGP)").fill("30.00");
  await page.route(`**/api/v1/center/students/${studentId}/payments`, async (route) => {
    await route.fetch();
    await route.abort("failed");
    await page.unroute(`**/api/v1/center/students/${studentId}/payments`);
  });
  await page.getByRole("button", { name: "تسجيل الدفعة" }).click();
  await expect(page.getByRole("button", { name: "إلغاء بيانات الدفعة" })).toBeDisabled();
  await page.getByRole("button", { name: "التحقق من الدفعة" }).click();
  await expect(page.getByText("سُجلت الدفعة المقدمة", { exact: false })).toBeVisible();
  const saved = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  expect(saved.account.available_balance).toBe("30.00");
  expect(saved.payments).toHaveLength(1);
});

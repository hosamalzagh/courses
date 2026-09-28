import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_FEE_CREDENTIALS, "Requires the isolated PostgreSQL fee fixture.");
const origin = process.env.COURSES_FEE_ORIGIN ?? "http://alpha.courses.test:8051";
const credentials = process.env.COURSES_FEE_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_FEE_CREDENTIALS, "utf8")) : {};

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

test("withdrawal fee settlement and correction preserve money, permissions, audit and RTL", async ({ browser }) => {
  test.setTimeout(90_000);
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const branchId = workspace.branches.find((item: { slug: string }) => item.slug === "north").id;
    const course = await write(owner, "courses", { branch_id: branchId, name: `Fee ${crypto.randomUUID().slice(0, 6)}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(), lectures: [{ number: 1, content: "Lecture", planned_hours: 2 }] });
    const instructor = await write(owner, "instructors", { name: `Teacher ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
    const createdGroup = await write(owner, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: `Group ${crypto.randomUUID().slice(0, 6)}`, approved_price: "1000.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(createdGroup.status).toBe(201);
    const student = await write(owner, "students", { name: `Fee Student ${Date.now()}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const studentId = student.body.student.id;
    const accountPath = `students/${studentId}/account`;
    const account = await (await owner.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
    if (!account.account.currency) expect((await write(owner, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
    const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/enrollments`)).json();
    const registered = await write(owner, `students/${studentId}/enrollments`, { group_id: createdGroup.body.group.id, group_revision: createdGroup.body.group.revision,
      currency_revision: enrollment.student.currency_revision, joined_on: "2026-09-28", discount: "0.00", discount_reason: null,
      version: enrollment.student.version, request_id: crypto.randomUUID() });
    expect(registered.status).toBe(201);
    const attempt = registered.body.attempt;
    const beforePayment = await (await owner.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
    const payment = await write(owner, `students/${studentId}/payments`, { branch_id: branchId, method: "cash", received_on: "2026-09-28",
      amount: "900.00", version: beforePayment.account.version, request_id: crypto.randomUUID() });
    expect(payment.status).toBe(201);
    const allocationPath = `students/${studentId}/payments/${payment.body.payment.id}`;
    const options = await (await owner.request.get(`${origin}/api/v1/center/${allocationPath}/allocation-options`)).json();
    expect((await write(owner, `${allocationPath}/allocations`, { targets: [{ attempt_id: attempt.id, amount: "900.00" }],
      version: options.version, request_id: crypto.randomUUID() })).status).toBe(201);
    expect((await write(owner, `students/${studentId}/enrollments/${attempt.id}/withdraw`, { withdrawn_on: "2026-09-28",
      reason: "انسحاب موثق", revision: attempt.revision, request_id: crypto.randomUUID() })).status).toBe(200);
    const withdrawn = await (await owner.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
    expect(withdrawn.account).toMatchObject({ due_total: "1000.00", paid_total: "900.00", available_balance: "0.00" });

    await owner.goto(`${origin}/admin/students/${studentId}/account`);
    const accountResponse = await owner.request.get(`${origin}/api/v1/center/${accountPath}`);
    expect(Number(accountResponse.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    const html = await owner.request.get(`${origin}/admin/students/${studentId}/account`);
    expect(await html.text()).toContain("1000.00");
    await owner.route(`**/api/v1/center/students/${studentId}/fees/${attempt.fee.id}/adjustments?*`, async route => {
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({ response, json: { ...detail, pagination: { ...detail.pagination, history_has_more: true } } });
    });
    await owner.getByRole("button", { name: "تسوية أو تصحيح" }).click();
    await expect(owner.getByRole("heading", { name: new RegExp("تسوية رسوم") })).toBeFocused();
    await owner.getByLabel("المستحق الجديد (EGP)").fill("800.00");
    await owner.getByLabel("سبب التسوية أو التصحيح").fill("تسوية بعد الانسحاب");
    await owner.getByRole("button", { name: "معاينة الأثر" }).click();
    await expect(owner.getByRole("region", { name: "معاينة أثر التسوية" })).toContainText("100.00");
    await expect(owner.getByRole("button", { name: "قرارات أقدم" })).toBeEnabled();
    await owner.getByRole("button", { name: "اعتماد التسوية" }).click();
    await expect(owner.getByRole("alertdialog")).toContainText("800.00 EGP");
    const settlementPath = `**/api/v1/center/students/${studentId}/fees/${attempt.fee.id}/adjustments`;
    await owner.route(settlementPath, async route => {
      await route.fetch();
      await route.abort("failed");
      await owner.unroute(settlementPath);
    });
    await owner.getByRole("button", { name: "تأكيد التسوية" }).click();
    await expect(owner.getByRole("button", { name: "التحقق من الاعتماد" })).toBeVisible();
    await expect(owner.getByLabel("المستحق الجديد (EGP)")).toBeDisabled();
    await expect(owner.getByLabel("سبب التسوية أو التصحيح")).toBeDisabled();
    await expect(owner.getByRole("button", { name: "قرارات أقدم" })).toBeDisabled();
    await owner.getByRole("button", { name: "التحقق من الاعتماد" }).click();
    await owner.getByRole("button", { name: "تأكيد التسوية" }).click();
    await expect(owner.getByRole("button", { name: "تسوية أو تصحيح" })).toBeFocused();
    const settled = await (await owner.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
    expect(settled.account).toMatchObject({ due_total: "800.00", paid_total: "800.00", available_balance: "100.00" });
    const settlementHistory = await (await owner.request.get(`${origin}/api/v1/center/students/${studentId}/fees/${attempt.fee.id}/adjustments`)).json();
    expect(settlementHistory.history).toHaveLength(1);

    await owner.getByRole("button", { name: "تسوية أو تصحيح" }).click();
    await expect(owner.getByText("-200.00 EGP").first()).toBeVisible();
    await owner.getByRole("button", { name: "تصحيح هذه التسوية" }).click();
    await expect(owner.getByLabel("المستحق الجديد (EGP)")).toHaveValue("1000.00");
    await owner.getByLabel("المستحق الجديد (EGP)").fill("1000.00");
    await owner.getByLabel("سبب التسوية أو التصحيح").fill("تصحيح قرار خاطئ");
    await owner.getByRole("button", { name: "معاينة الأثر" }).click();
    await owner.getByRole("button", { name: "اعتماد التصحيح" }).click();
    await owner.getByRole("button", { name: "تأكيد التصحيح" }).click();
    await expect(owner.getByRole("button", { name: "تسوية أو تصحيح" })).toBeFocused();
    const corrected = await (await owner.request.get(`${origin}/api/v1/center/${accountPath}`)).json();
    expect(corrected.account).toMatchObject({ due_total: "1000.00", paid_total: "800.00", available_balance: "100.00", debt: "200.00" });
    await owner.goto(`${origin}/admin/audit`);
    await expect(owner.getByText("تصحيح تسوية رسوم محاولة دراسة").first()).toBeVisible();
    await owner.getByText("تفاصيل قرار الرسوم").first().click();
    await expect(owner.getByText("تصحيح قرار خاطئ").first()).toBeVisible();

    expect((await write(owner, `members/${credentials.staff.membership_id}/grants`, { center_roles: [], branch_roles: { [branchId]: ["accounting"] } }, "PUT")).status).toBe(200);
    await signIn(staff, "staff");
    await staff.goto(`${origin}/admin/students/${studentId}/account`);
    await expect(staff.getByRole("button", { name: "تسوية أو تصحيح" })).toHaveCount(0);
    const denied = await staff.request.get(`${origin}/api/v1/center/students/${studentId}/fees/${attempt.fee.id}/adjustments?new_due=500.00`);
    expect(denied.status()).toBe(403);
    await owner.goto(`${origin}/admin/students/${studentId}/account`);
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.locator("html").getAttribute("dir")).toBe("rtl");
    await owner.getByRole("button", { name: "القائمة" }).click();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.getByRole("button", { name: "إغلاق القائمة" }).click();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await owner.close(); await staff.close(); }
});

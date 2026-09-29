import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_COVERAGE_CREDENTIALS || !process.env.COURSES_COVERAGE_QUERY_LOG,
  "Requires protected browser credentials and an SSR query log on disposable PostgreSQL.");
const origin = process.env.COURSES_COVERAGE_ORIGIN ?? "http://alpha.courses.test:8067";
const credentials = process.env.COURSES_COVERAGE_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_COVERAGE_CREDENTIALS, "utf8")) : {};

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

test("academic staff applies a newer plan to a selected attempt without changing its group", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north").id as number;
    const course = await write(owner, "courses", { branch_id: north, name: `New plan ${crypto.randomUUID().slice(0, 6)}`, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "مرحلة", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, { name: "مستوى", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "محاضرة أصلية", planned_hours: 1 }] });
    expect(level.status).toBe(201);
    const instructor = await write(owner, "instructors", { name: `Teacher ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(instructor.status).toBe(201);
    const group = await write(owner, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
      name: `Group ${crypto.randomUUID().slice(0, 6)}`, approved_price: "0.00",
      instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
    expect(group.status).toBe(201);
    const student = await write(owner, "students", { name: `طالب الإصدار ${Date.now()}`, branch_ids: [north], request_id: crypto.randomUUID() });
    expect(student.status).toBe(201);
    const account = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/account`)).json();
    if (!account.account.currency) expect((await write(owner, "financial-currency", {
      currency: "EGP", revision: account.account.currency_revision,
    }, "PATCH")).status).toBe(200);
    const enrollment = await (await owner.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/enrollments`)).json();
    const attempt = await write(owner, `students/${student.body.student.id}/enrollments`, {
      group_id: group.body.group.id, group_revision: group.body.group.revision,
      currency_revision: enrollment.student.currency_revision,
      joined_on: new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" }),
      discount: "0.00", discount_reason: null, version: enrollment.student.version, request_id: crypto.randomUUID(),
    });
    expect(attempt.status).toBe(201);
    const plan = await write(owner, `levels/${level.body.level.id}/plan-versions`, {
      base_plan_version_id: level.body.level.plan.id, base_revision: 1,
      lectures: [{ number: 1, content: "محاضرة بديلة", planned_hours: 1 },
        { number: 2, content: "محاضرة إضافية", planned_hours: 1 }], request_id: crypto.randomUUID(),
    });
    expect(plan.status).toBe(201);
    const path = `groups/${group.body.group.id}/coverage`;
    const url = `${origin}/admin/${path}`;
    const beforeSsr = readFileSync(process.env.COURSES_COVERAGE_QUERY_LOG!, "utf8").trim().split("\n").length;
    expect((await (await owner.request.get(url)).text())).toContain(student.body.student.name);
    const reads = readFileSync(process.env.COURSES_COVERAGE_QUERY_LOG!, "utf8").trim().split("\n").slice(beforeSsr)
      .map(line => JSON.parse(line) as { path: string; count: number | null }).filter(read => read.path === `/api/v1/center/${path}`);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(read => Number.isInteger(read.count) && read.count! <= 6)).toBe(true);
    await owner.goto(url);
    const launch = owner.locator("header.center-topbar").getByRole("button", { name: "تطبيق إصدار خطة جديد" });
    await launch.click();
    await expect(owner.getByRole("heading", { name: "تطبيق إصدار خطة جديد على محاولات مختارة" })).toBeVisible();
    await owner.locator("header.center-topbar").getByRole("button", { name: "رجوع للتقرير" }).click();
    await expect(launch).toBeFocused();
    await launch.click();
    await owner.getByLabel("الإصدار الجديد").selectOption(plan.body.plan.id);
    await owner.getByLabel("ابحث عن رقم إصدار الخطة").fill("999999");
    await owner.locator("header.center-topbar").getByRole("button", { name: "بحث في الإصدارات" }).click();
    await expect(owner.getByLabel("الإصدار الجديد")).toHaveValue(plan.body.plan.id);
    await expect(owner.getByLabel("الإصدار الجديد").locator(`option[value="${plan.body.plan.id}"]`)).toHaveCount(1);
    await owner.getByRole("checkbox", { name: `اختيار محاولة ${student.body.student.name} لتطبيق إصدار الخطة` }).check();
    await owner.getByLabel("سبب التطبيق").fill("اعتماد إصدار الخطة الجديد بعد المراجعة");
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة أثر الإصدار" }).click();
    await expect(owner.getByRole("heading", { name: /أثر الإصدار/ })).toBeFocused();
    await owner.getByText("متطلبات الإصدار المقترح (٢)").click();
    await expect(owner.getByText(/محاضرة إضافية/)).toBeVisible();
    await owner.getByText("متطلبات المحاولة السابقة (١)").click();
    await expect(owner.getByText(/محاضرة أصلية/)).toBeVisible();
    await expect(owner.getByText(/^قبل: ٠\/١/)).toBeVisible();
    await expect(owner.getByText(/^بعد: ٠\/٢/)).toBeVisible();
    const applicationRequests: string[] = [];
    let dropFirstConfirmation = true;
    let rejectOneReplay = true;
    await owner.route(`**/api/v1/center/groups/${group.body.group.id}/plan-applications`, async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      applicationRequests.push((JSON.parse(route.request().postData() ?? "{}") as { request_id: string }).request_id);
      if (dropFirstConfirmation) {
        dropFirstConfirmation = false;
        expect((await route.fetch()).status()).toBe(201);
        await route.abort("failed");
        return;
      }
      if (rejectOneReplay) {
        rejectOneReplay = false;
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "لا يمكن التحقق الآن" }) });
        return;
      }
      await route.continue();
    });
    await owner.locator("header.center-topbar").getByRole("button", { name: "تأكيد التطبيق على المختارين" }).click();
    await expect(owner.getByText(/انقطع الاتصال أثناء الاعتماد/)).toBeVisible();
    await expect(owner.getByLabel("الإصدار الجديد")).toBeDisabled();
    await expect(owner.getByLabel("سبب التطبيق")).toBeDisabled();
    await expect(owner.getByRole("checkbox", { name: `اختيار محاولة ${student.body.student.name} لتطبيق إصدار الخطة` })).toBeDisabled();
    await expect(owner.locator("header.center-topbar").getByRole("button", { name: "رجوع للتقرير" })).toBeDisabled();
    await owner.locator('a[href="/admin"]').first().click();
    await expect(owner.getByRole("alertdialog", { name: "تحقق من نتيجة تطبيق الخطة أولًا" })).toBeVisible();
    await expect(owner.getByRole("button", { name: "مغادرة دون حفظ" })).toHaveCount(0);
    await owner.getByRole("button", { name: "العودة للتحقق" }).click();
    await owner.locator("header.center-topbar").getByRole("button", { name: "التحقق من نتيجة التطبيق" }).click();
    await expect.poll(() => applicationRequests.length).toBe(2);
    await expect(owner.getByText(/تعذر التحقق من نتيجة الاعتماد/)).toBeVisible();
    await expect(owner.getByLabel("سبب التطبيق")).toBeDisabled();
    await owner.locator("header.center-topbar").getByRole("button", { name: "التحقق من نتيجة التطبيق" }).click();
    await expect.poll(() => applicationRequests.length).toBe(3);
    expect(applicationRequests[1]).toBe(applicationRequests[0]);
    expect(applicationRequests[2]).toBe(applicationRequests[0]);
    await expect(owner.getByRole("row", { name: new RegExp(student.body.student.name) })).toContainText("٠/٢");
    const report = await (await owner.request.get(`${origin}/api/v1/center/${path}`)).json();
    expect(report.group.plan_version_id).toBe(level.body.level.plan.id);
    expect(report.students.find((row: { attempt_id: string }) => row.attempt_id === attempt.body.attempt.id).plan_version_id).toBe(plan.body.plan.id);
    const nextPlan = await write(owner, `levels/${level.body.level.id}/plan-versions`, {
      base_plan_version_id: plan.body.plan.id, base_revision: 1,
      lectures: [{ number: 1, content: "محاضرة ثالثة", planned_hours: 1 },
        { number: 2, content: "محاضرة إضافية", planned_hours: 1 }], request_id: crypto.randomUUID(),
    });
    expect(nextPlan.status).toBe(201);
    await launch.click();
    await owner.getByLabel("الإصدار الجديد").selectOption(nextPlan.body.plan.id);
    await owner.getByRole("checkbox", { name: `اختيار محاولة ${student.body.student.name} لتطبيق إصدار الخطة` }).check();
    const draftReason = "تطبيق إصدار أحدث مع المحافظة على مسودة التعارض";
    await owner.getByLabel("سبب التطبيق").fill(draftReason);
    await owner.locator("header.center-topbar").getByRole("button", { name: "معاينة أثر الإصدار" }).click();
    const requirementChange = { kind: "add", content: "متطلب إضافي لتحديث المجموعة", reason: "تعديل متطلبات المجموعة أثناء مراجعة الإصدار" };
    const directPreview = await write(owner, `${path.replace("/coverage", "")}/requirements/preview`, requirementChange);
    expect(directPreview.status).toBe(200);
    const directApply = await write(owner, `${path.replace("/coverage", "")}/requirements`, {
      ...requirementChange,
      group_revision: directPreview.body.group_revision, preview_token: directPreview.body.preview_token,
      request_id: crypto.randomUUID(),
    });
    expect(directApply.status).toBe(201);
    await owner.locator("header.center-topbar").getByRole("button", { name: "تأكيد التطبيق على المختارين" }).click();
    await expect(owner.getByRole("alert").locator("..")).toBeFocused();
    await owner.locator("header.center-topbar").getByRole("button", { name: "تحميل أحدث التقرير" }).click();
    await expect(owner.getByLabel("الإصدار الجديد")).toBeFocused();
    await expect(owner.getByRole("heading", { name: "تطبيق إصدار خطة جديد على محاولات مختارة" })).toBeVisible();
    await expect(owner.getByLabel("الإصدار الجديد")).toHaveValue(nextPlan.body.plan.id);
    await expect(owner.getByLabel("سبب التطبيق")).toHaveValue(draftReason);
    await expect(owner.getByRole("checkbox", { name: `اختيار محاولة ${student.body.student.name} لتطبيق إصدار الخطة` })).toBeChecked();
    await owner.locator("header.center-topbar").getByRole("button", { name: "رجوع للتقرير" }).click();
    await owner.getByRole("button", { name: "الرجوع دون تطبيق" }).click();
    await expect(launch).toBeFocused();
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.locator("html").getAttribute("dir")).toBe("rtl");
    await owner.getByRole("button", { name: "القائمة" }).click();
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await signIn(staff, "staff");
    await staff.goto(url);
    await expect(staff.getByText(student.body.student.name)).toBeVisible();
    await expect(staff.locator("header.center-topbar").getByRole("button", { name: "تطبيق إصدار خطة جديد" })).toHaveCount(0);
    const denied = await write(staff, `groups/${group.body.group.id}/plan-applications/preview`, {
      target_plan_version_id: plan.body.plan.id, attempt_ids: [attempt.body.attempt.id], reason: "محاولة غير مصرح بها",
    });
    expect(denied.status).toBe(403);
  } finally { await owner.close(); await staff.close(); }
});

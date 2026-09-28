import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_ATTACHMENTS_CREDENTIALS, "Requires the disposable attachment PostgreSQL fixture.");
const origin = process.env.COURSES_ATTACHMENTS_ORIGIN ?? "http://alpha.courses.test:8057";
const credentials = process.env.COURSES_ATTACHMENTS_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_ATTACHMENTS_CREDENTIALS, "utf8"))
  : {};
const image = {
  name: "student.png", mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAHUlEQVQ4jWMUSbFhIBcwka1zVPOo5lHNo5qpohkAvIEA3Cu5xEYAAAAASUVORK5CYII=", "base64"),
};
const pdf = { name: "updated.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF") };

async function signIn(page: Page, who: "alpha" | "staff" = "alpha") {
  await page.goto(`${origin}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).pressSequentially(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).pressSequentially(credentials[who].password);
  expect(await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).inputValue() === credentials[who].password).toBe(true);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, route: string, method: string, payload: object) {
  return page.evaluate(async ({ route, method, payload }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, method, payload });
}

test("replacement, history, archive and restoration work through the employee UI", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const created = await write(page, "students", "POST", {
    name: `نسخ مستند ${Date.now()}`, branch_ids: [workspace.branches[0].id], request_id: crypto.randomUUID(),
  });
  expect(created.status).toBe(201);
  const student = created.body.student;
  await page.goto(`${origin}/admin/students/${student.id}?tab=attachments`);
  await page.getByLabel("اختر صورًا أو PDF").setInputFiles(image);
  await page.getByRole("button", { name: "رفع المرفقات", exact: true }).click();
  await expect(page.getByRole("button", { name: "نسخ وإجراءات student" })).toBeVisible();
  await page.getByRole("button", { name: "نسخ وإجراءات student" }).click();
  await expect(page.getByRole("heading", { name: "نسخ student" })).toBeFocused();
  await expect(page.getByText("نسخة ١", { exact: false })).toBeVisible();
  await page.getByLabel("عنوان الوثيقة").fill("عنوان لم يُحفظ");
  await page.getByRole("button", { name: "إغلاق النسخ" }).click();
  await expect(page.getByRole("alertdialog").getByText("إغلاق النسخ دون حفظ")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "إلغاء" }).click();
  await page.getByLabel("عنوان الوثيقة").fill("student");
  const first = await (await page.request.get(`${origin}/api/v1/center/students/${student.id}/attachments/${(await (await page.request.get(`${origin}/api/v1/center/students/${student.id}?tab=attachments`)).json()).attachments.entries[0].id}/versions`)).json();
  const oldUrl = first.versions[0].download_url;
  await page.getByLabel("ملف النسخة الجديدة").setInputFiles(pdf);
  await page.getByLabel("عنوان الوثيقة").fill("عنوان مسودة النسخة");
  await page.getByLabel("تصنيف الوثيقة (يُحفظ بإجراء مستقل)").selectOption("identity");
  await page.getByRole("button", { name: "حفظ التصنيف" }).click();
  await expect(page.getByLabel("عنوان الوثيقة")).toHaveValue("عنوان مسودة النسخة");
  expect(await page.getByLabel("ملف النسخة الجديدة").evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe("updated.pdf");
  await page.getByLabel("تصنيف الوثيقة (يُحفظ بإجراء مستقل)").selectOption("general");
  await page.getByRole("button", { name: "حفظ نسخة جديدة" }).click();
  await expect(page.getByText("نسخة ٢", { exact: false })).toBeVisible();
  await expect(page.getByLabel("تصنيف الوثيقة (يُحفظ بإجراء مستقل)")).toHaveValue("general");
  await expect(page.getByRole("button", { name: "حفظ التصنيف" })).toBeVisible();
  expect((await page.request.get(`${origin}${oldUrl}`)).status()).toBe(200);
  await page.getByRole("button", { name: "أرشفة الوثيقة", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "أرشفة الوثيقة" }).click();
  await expect(page.getByText("أُرشف المرفق مع نسخه.")).toBeVisible();
  await page.getByRole("link", { name: "عرض المؤرشفة" }).click();
  await expect(page.getByRole("button", { name: "نسخ وإجراءات عنوان مسودة النسخة" })).toBeVisible();
  await page.getByRole("button", { name: "نسخ وإجراءات عنوان مسودة النسخة" }).click();
  await page.getByRole("button", { name: "استعادة الوثيقة" }).click();
  await expect(page.getByText("استُعيد المرفق.")).toBeVisible();
  await page.getByRole("link", { name: "عرض الحالية" }).click();
  await expect(page.getByRole("button", { name: "نسخ وإجراءات عنوان مسودة النسخة" })).toBeVisible();
  const read = await page.request.get(`${origin}/api/v1/center/students/${student.id}?tab=attachments`);
  expect(Number(read.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.getByRole("button", { name: "القائمة" }).click();
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "إغلاق القائمة" }).click();
  await expect(page.getByRole("link", { name: "عرض المؤرشفة" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`${origin}/admin/audit`);
  await expect(page.getByText("استعادة وثيقة الطالب")).toBeVisible();
});

test("reclassification and grant revocation block a previously opened historical URL", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    await signIn(staff, "staff");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north");
    const created = await write(owner, "students", "POST", {
      name: `وثيقة صلاحية ${Date.now()}`, branch_ids: [north.id], request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const student = created.body.student;
    await owner.goto(`${origin}/admin/students/${student.id}?tab=attachments`);
    await owner.getByLabel("اختر صورًا أو PDF").setInputFiles(image);
    await owner.getByRole("button", { name: "رفع المرفقات", exact: true }).click();
    await expect(owner.getByRole("button", { name: "نسخ وإجراءات student" })).toBeVisible();
    const attachment = (await (await owner.request.get(`${origin}/api/v1/center/students/${student.id}?tab=attachments`)).json()).attachments.entries[0];
    const oldUrl = (await (await owner.request.get(`${origin}/api/v1/center/students/${student.id}/attachments/${attachment.id}/versions`)).json()).versions[0].download_url;
    expect((await staff.request.get(`${origin}${oldUrl}`)).status()).toBe(200);
    await staff.goto(`${origin}/admin/students/${student.id}?tab=attachments`);
    await staff.getByRole("button", { name: "نسخ وإجراءات student" }).click();
    await staff.getByLabel("ملف النسخة الجديدة").setInputFiles(pdf);
    await staff.getByLabel("عنوان الوثيقة").fill("مسودة الموظف");
    await owner.getByRole("button", { name: "نسخ وإجراءات student" }).click();
    await owner.getByLabel("ملف النسخة الجديدة").setInputFiles(pdf);
    await owner.getByLabel("عنوان الوثيقة").fill("عنوان محدث من المدير");
    await owner.getByRole("button", { name: "حفظ نسخة جديدة" }).click();
    await expect(owner.getByText("نسخة ٢", { exact: false })).toBeVisible();
    await staff.getByRole("button", { name: "حفظ نسخة جديدة" }).click();
    await expect(staff.getByRole("button", { name: "تحميل أحدث المرفقات" })).toBeVisible();
    await staff.getByRole("button", { name: "تحميل أحدث المرفقات" }).click();
    await expect(staff.getByLabel("عنوان الوثيقة")).toHaveValue("عنوان محدث من المدير");
    await expect(staff.getByRole("button", { name: "حفظ نسخة جديدة" })).toBeEnabled();
    await staff.getByRole("button", { name: "إغلاق النسخ" }).click();
    await staff.getByRole("alertdialog").getByRole("button", { name: "إغلاق دون حفظ" }).click();
    await owner.getByRole("button", { name: "إغلاق النسخ" }).click();
    await owner.getByRole("button", { name: "نسخ وإجراءات عنوان محدث من المدير" }).click();
    await owner.getByLabel("تصنيف الوثيقة (يُحفظ بإجراء مستقل)").selectOption("identity");
    await owner.getByRole("button", { name: "حفظ التصنيف" }).click();
    await expect(owner.getByText("تغير التصنيف؛ ستُفحص صلاحية كل نسخة عند فتحها.")).toBeVisible();
    const identityUrl = (await (await owner.request.get(`${origin}/api/v1/center/students/${student.id}/attachments/${attachment.id}/versions`)).json()).versions[0].download_url;
    expect((await staff.request.get(`${origin}${oldUrl}`)).status()).toBe(404);
    expect((await staff.request.get(`${origin}/api/v1/center/students/${student.id}?tab=attachments`)).status()).toBe(200);
    const grant = (roles: string[]) => write(owner, `members/${credentials.staff.membership_id}/grants`, "PUT", { center_roles: [], branch_roles: { [north.id]: roles } });
    expect((await grant(["registration", "student_identity"])).status).toBe(200);
    expect((await staff.request.get(`${origin}${oldUrl}`)).status()).toBe(200);
    expect((await grant(["registration"])).status).toBe(200);
    expect((await staff.request.get(`${origin}${oldUrl}`)).status()).toBe(404);
    await owner.getByLabel("تصنيف الوثيقة (يُحفظ بإجراء مستقل)").selectOption("general");
    const reclassified = owner.waitForResponse(response => response.url().endsWith(`/attachments/${attachment.id}/classification`) && response.request().method() === "PATCH");
    await owner.getByRole("button", { name: "حفظ التصنيف" }).click();
    expect((await reclassified).status()).toBe(200);
    await expect(owner.getByText("تغير التصنيف؛ ستُفحص صلاحية كل نسخة عند فتحها.")).toBeVisible();
    expect((await staff.request.get(`${origin}${attachment.download_url}`)).status()).toBe(200);
    expect((await staff.request.get(`${origin}${identityUrl}`)).status()).toBe(404);
    await staff.goto(`${origin}/admin/students/${student.id}?tab=attachments`);
    await staff.getByRole("button", { name: "نسخ وإجراءات عنوان محدث من المدير" }).click();
    await staff.getByRole("button", { name: "أرشفة الوثيقة", exact: true }).click();
    await staff.getByRole("alertdialog").getByRole("button", { name: "أرشفة الوثيقة" }).click();
    await expect(staff.getByText("أُرشف المرفق مع نسخه.")).toBeVisible();
    await expect(staff.getByRole("heading", { name: "نسخ عنوان محدث من المدير" })).toHaveCount(0);
  } finally {
    await owner.close();
    await staff.close();
  }
});

test("identity attachment controls require management and identity access in the same branch", async ({ browser }) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  try {
    await signIn(owner);
    await signIn(staff, "staff");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const north = workspace.branches.find((branch: { slug: string }) => branch.slug === "north");
    const south = workspace.branches.find((branch: { slug: string }) => branch.slug === "south");
    const created = await write(owner, "students", "POST", {
      name: `وثيقة فرعين ${Date.now()}`, branch_ids: [north.id, south.id], request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const student = created.body.student;
    await owner.goto(`${origin}/admin/students/${student.id}?tab=attachments`);
    await owner.getByLabel("اختر صورًا أو PDF").setInputFiles(image);
    await owner.getByLabel("تصنيف student.png").selectOption("identity");
    await owner.getByRole("button", { name: "رفع المرفقات", exact: true }).click();
    await expect(owner.getByRole("button", { name: "نسخ وإجراءات student" })).toBeVisible();
    const grant = await write(owner, `members/${credentials.staff.membership_id}/grants`, "PUT", {
      center_roles: [], branch_roles: { [north.id]: ["registration"], [south.id]: ["branch_viewer", "student_identity"] },
    });
    expect(grant.status).toBe(200);
    await staff.goto(`${origin}/admin/students/${student.id}?tab=attachments`);
    await expect(staff.getByRole("button", { name: "نسخ وإجراءات student" })).toBeVisible();
    await staff.getByRole("button", { name: "نسخ وإجراءات student" }).click();
    await expect(staff.getByRole("heading", { name: "نسخ student" })).toBeFocused();
    await expect(staff.getByLabel("ملف النسخة الجديدة")).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "أرشفة الوثيقة" })).toHaveCount(0);
    await expect(staff.getByRole("link", { name: "تنزيل النسخة 1" })).toBeVisible();
  } finally {
    await owner.close();
    await staff.close();
  }
});

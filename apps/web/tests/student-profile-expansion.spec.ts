import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const origin = process.env.COURSES_PROFILE_EXPANSION_ORIGIN;
const credentialsFile = process.env.COURSES_PROFILE_EXPANSION_CREDENTIALS;
const queryLog = process.env.COURSES_PROFILE_EXPANSION_QUERY_LOG;
const image = { name: "student.png", mimeType: "image/png", buffer: Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAHUlEQVQ4jWMUSbFhIBcwka1zVPOo5lHNo5qpohkAvIEA3Cu5xEYAAAAASUVORK5CYII=",
  "base64",
) };
test.skip(!origin || !credentialsFile || !queryLog, "Requires an isolated two-center PostgreSQL fixture and measured Next.js proxy.");
test.setTimeout(120_000);

const credentials = credentialsFile ? JSON.parse(readFileSync(credentialsFile, "utf8")) : {};

async function signIn(page: Page, host = origin!) {
  await page.goto(`${host}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials.alpha.email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials.alpha.password);
  const login = page.waitForResponse(response => response.url().endsWith("/api/v1/center/auth/login") && response.request().method() === "POST");
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  expect((await login).status()).toBe(200);
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

function cursor(): number {
  return readFileSync(queryLog!, "utf8").trim().split("\n").filter(Boolean).length;
}

function assertMeasuredPage(after: number, studentId: string) {
  const reads = readFileSync(queryLog!, "utf8").trim().split("\n").filter(Boolean).slice(after)
    .map(row => JSON.parse(row) as { path: string; count: number | null })
    .filter(row => row.path.startsWith("/api/v1/center/"));
  expect(reads.some(read => read.path.startsWith(`/api/v1/center/students/${studentId}`)),
    "SSR must make a measured student read").toBe(true);
  for (const read of reads) {
    expect(Number.isInteger(read.count), `Missing SQL counter for ${read.path}`).toBe(true);
    expect(read.count!, `SQL count for ${read.path}`).toBeLessThanOrEqual(6);
  }
  expect(reads.reduce((total, read) => total + read.count!, 0), "Combined center SSR reads").toBeLessThanOrEqual(6);
  return reads.map(read => ({ path: read.path, count: read.count! }));
}

test("one authorized profile keeps real study, payment and note data across measured SSR tabs", async ({ page }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branch = workspace.branches[0].id as number;
  const unique = crypto.randomUUID().slice(0, 8);

  const course = await write(page, "courses", { branch_id: branch, name: `Acceptance ${unique}`, request_id: crypto.randomUUID() });
  expect(course.status).toBe(201);
  const stage = await write(page, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
  expect(stage.status).toBe(201);
  const level = await write(page, `stages/${stage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(),
    lectures: [{ number: 1, content: "Required", planned_hours: 1 }] });
  expect(level.status).toBe(201);
  const instructor = await write(page, "instructors", { name: `Teacher ${unique}`, branch_ids: [branch], request_id: crypto.randomUUID() });
  expect(instructor.status).toBe(201);
  const group = await write(page, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
    name: `Group ${unique}`, approved_price: "100.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
  expect(group.status).toBe(201);

  await page.goto(`${origin}/admin/students/new`);
  await page.getByRole("textbox", { name: "اسم الطالب", exact: true }).fill(`قبول التوسعة ${unique}`);
  const creation = page.waitForResponse(response => response.url().endsWith("/api/v1/center/students") && response.request().method() === "POST");
  await page.getByRole("button", { name: "حفظ ملف الطالب", exact: true }).click();
  const created = await creation;
  expect(created.status()).toBe(201);
  const studentId = (await created.json()).student.id as string;
  await expect(page).toHaveURL(new RegExp(`/admin/students/${studentId}`));
  const enrollments = `students/${studentId}/enrollments`;
  let enrollment = await (await page.request.get(`${origin}/api/v1/center/${enrollments}`)).json();
  if (!enrollment.student.currency) {
    expect((await write(page, "financial-currency", { currency: "EGP", revision: enrollment.student.currency_revision }, "PATCH")).status).toBe(200);
    enrollment = await (await page.request.get(`${origin}/api/v1/center/${enrollments}`)).json();
  }
  const attempt = await write(page, enrollments, { group_id: group.body.group.id, group_revision: group.body.group.revision,
    currency_revision: enrollment.student.currency_revision, joined_on: "2026-09-28", discount: "0.00", discount_reason: null,
    version: enrollment.student.version, request_id: crypto.randomUUID() });
  expect(attempt.status).toBe(201);
  const account = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  const payment = await write(page, `students/${studentId}/payments`, { branch_id: branch, method: "cash", received_on: "2026-09-28",
    amount: "30.00", version: account.account.version, request_id: crypto.randomUUID() });
  expect(payment.status).toBe(201);
  expect((await write(page, `students/${studentId}/payments/${payment.body.payment.id}/note`, {
    body: `متابعة مالية ${unique}`, important: true, revision: 0, request_id: crypto.randomUUID(),
  }, "PUT")).status).toBe(201);

  const paths = [
    { path: "", text: `قبول التوسعة ${unique}` },
    { path: "?tab=study", text: `Group ${unique}` },
    { path: "?tab=attachments", text: "لا توجد مرفقات متاحة ضمن صلاحياتك." },
    { path: "?tab=custom-history", text: "لا يوجد تاريخ متاح ضمن صلاحياتك." },
    { path: "?tab=notes", text: `متابعة مالية ${unique}` },
    { path: "/enrollments", text: `Group ${unique}` },
    { path: "/account", text: "30.00 EGP" },
  ];
  const measurements: { route: string; state: string; reads: { path: string; count: number }[] }[] = [];
  for (const { path, text } of paths) {
    const url = `${origin}/admin/students/${studentId}${path}`;
    for (const state of ["cold", "warm"]) {
      const before = cursor();
      await page.goto(url, { waitUntil: "networkidle" });
      await expect(page.getByText(text, { exact: false }).first(), `${state} ${path}`).toBeVisible();
      measurements.push({ route: path || "profile", state, reads: assertMeasuredPage(before, studentId) });
    }
  }
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("30.00 EGP", { exact: false }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`${origin}/admin/students/${studentId}`, { waitUntil: "networkidle" });
  let documentRequests = 0;
  const countDocuments = (request: { resourceType(): string }) => {
    if (request.resourceType() === "document") documentRequests++;
  };
  page.on("request", countDocuments);
  for (const [label, expected] of [["الدراسة", `Group ${unique}`], ["الحساب المالي", "30.00 EGP"]] as const) {
    const before = cursor();
    await page.getByRole("navigation", { name: "أقسام ملف الطالب" }).getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByText(expected, { exact: false }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    measurements.push({ route: `client:${label}`, state: "navigation", reads: assertMeasuredPage(before, studentId) });
  }
  page.off("request", countDocuments);
  expect(documentRequests, "Client navigation keeps the page shell").toBe(0);
  console.log(`Profile expansion SSR: ${JSON.stringify(measurements)}`);
});

test("one central employee identity keeps alpha and beta profiles, values and sessions separate", async ({ browser }) => {
  const alpha = await browser.newPage();
  const beta = await browser.newPage();
  const betaOrigin = origin!.replace("alpha.", "beta.");
  try {
    await signIn(alpha);
    const alphaWorkspace = await (await alpha.request.get(`${origin}/api/v1/center/student-workspace`)).json();
    const copiedSession = await browser.newContext({ storageState: await alpha.context().storageState() });
    try {
      const copied = await copiedSession.newPage();
      await copied.goto(`${betaOrigin}/admin/students`);
      await expect(copied).toHaveURL(new RegExp(`${betaOrigin}/login`));
    } finally {
      await copiedSession.close();
    }
    await signIn(beta, betaOrigin);
    const betaWorkspace = await (await beta.request.get(`${betaOrigin}/api/v1/center/student-workspace`)).json();
    expect(betaWorkspace.center.id).not.toBe(alphaWorkspace.center.id);
    const unique = crypto.randomUUID().slice(0, 8);
    const alphaStudent = await write(alpha, "students", { name: `ألفا ${unique}`, school: "مدرسة ألفا",
      branch_ids: [alphaWorkspace.branches[0].id], request_id: crypto.randomUUID() });
    expect(alphaStudent.status).toBe(201);
    const betaStudent = await write(beta, "students", { name: `بيتا ${unique}`, school: "مدرسة بيتا",
      branch_ids: [betaWorkspace.branches[0].id], request_id: crypto.randomUUID() });
    expect(betaStudent.status).toBe(201);
    const alphaId = alphaStudent.body.student.id as string;
    const betaId = betaStudent.body.student.id as string;
    expect(alphaId).not.toBe(betaId);

    await alpha.goto(`${origin}/admin/students/${alphaId}`);
    await alpha.getByLabel("اختيار صورة الطالب", { exact: true }).setInputFiles(image);
    await alpha.getByRole("button", { name: "حفظ صورة الطالب", exact: true }).click();
    await expect(alpha.getByRole("img", { name: `صورة ألفا ${unique}`, exact: true })).toBeVisible();
    const alphaProfile = await (await alpha.request.get(`${origin}/api/v1/center/students/${alphaId}`)).json();
    const photoUrl = alphaProfile.students[0].photo.url as string;
    expect((await alpha.request.get(`${origin}${photoUrl}`)).status()).toBe(200);
    expect((await beta.request.get(`${betaOrigin}${photoUrl}`)).status()).toBe(404);

    await alpha.goto(`${origin}/admin/students/${alphaId}?tab=attachments`);
    await alpha.getByLabel("اختر صورًا أو PDF").setInputFiles(image);
    await alpha.getByRole("button", { name: "رفع المرفقات", exact: true }).click();
    await expect(alpha.getByRole("button", { name: "نسخ وإجراءات student" })).toBeVisible();
    const alphaAttachments = await (await alpha.request.get(`${origin}/api/v1/center/students/${alphaId}?tab=attachments`)).json();
    const attachmentUrl = alphaAttachments.attachments.entries[0].download_url as string;
    expect((await alpha.request.get(`${origin}${attachmentUrl}`)).status()).toBe(200);
    expect((await beta.request.get(`${betaOrigin}${attachmentUrl}`)).status()).toBe(404);

    for (const [page, host, ownId, ownValue, foreignId] of [
      [alpha, origin!, alphaId, "مدرسة ألفا", betaId],
      [beta, betaOrigin, betaId, "مدرسة بيتا", alphaId],
    ] as const) {
      const before = cursor();
      await page.goto(`${host}/admin/students/${ownId}`, { waitUntil: "networkidle" });
      await expect(page.getByText(ownValue, { exact: true })).toBeVisible();
      assertMeasuredPage(before, ownId);
      for (const route of [`students/${foreignId}`, `students/${foreignId}?tab=attachments`,
        `students/${foreignId}/account`, `students/${foreignId}/enrollments`, `students/${foreignId}/barcode`]) {
        const response = await page.request.get(`${host}/api/v1/center/${route}`);
        expect(response.status(), `${host} ${route}`).toBe(404);
      }
      await page.goto(`${host}/admin/students/${foreignId}`);
      await expect(page.getByText("ملف الطالب غير متاح")).toBeVisible();
    }
  } finally {
    await alpha.close();
    await beta.close();
  }
});

test("long financial and note histories stay paged and measured", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branch = workspace.branches[0].id as number;
  const unique = crypto.randomUUID().slice(0, 8);
  const student = await write(page, "students", { name: `تاريخ طويل ${unique}`, branch_ids: [branch], request_id: crypto.randomUUID() });
  expect(student.status).toBe(201);
  const studentId = student.body.student.id as string;
  const accountRoute = `students/${studentId}/account`;
  let account = await (await page.request.get(`${origin}/api/v1/center/${accountRoute}`)).json();
  if (!account.account.currency) {
    expect((await write(page, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
  }
  for (let index = 0; index < 22; index++) {
    account = await (await page.request.get(`${origin}/api/v1/center/${accountRoute}`)).json();
    const payment = await write(page, `students/${studentId}/payments`, { branch_id: branch, method: "cash",
      received_on: "2026-09-28", amount: "1.00", version: account.account.version, request_id: crypto.randomUUID() });
    expect(payment.status, `payment ${index}`).toBe(201);
    const note = await write(page, `students/${studentId}/payments/${payment.body.payment.id}/note`, {
      body: `ملاحظة طويلة ${unique} رقم ${index}`, important: index === 0, revision: 0, request_id: crypto.randomUUID(),
    }, "PUT");
    expect(note.status, `note ${index}`).toBe(201);
  }
  for (const path of ["?tab=notes", "/account", "/account?page=2"]) {
    const before = cursor();
    await page.goto(`${origin}/admin/students/${studentId}${path}`, { waitUntil: "networkidle" });
    assertMeasuredPage(before, studentId);
  }
  const secondPage = page.getByRole("table", { name: "حركات الدفعات المقدمة" });
  await expect(secondPage.getByRole("row")).toHaveCount(3);
  await page.goto(`${origin}/admin/students/${studentId}?tab=notes`);
  const notes = page.getByRole("region", { name: "ملاحظات أحداث الطالب" });
  await expect(notes.getByRole("article")).toHaveCount(20);
  const pageTwo = page.waitForResponse(response => response.url().includes(`/api/v1/center/students/${studentId}/notes?page=2`));
  await page.getByRole("navigation", { name: "صفحات ملاحظات الأحداث" }).getByRole("button", { name: "التالي" }).click();
  const response = await pageTwo;
  expect(Number.isInteger(Number(response.headers()["x-courses-query-count"]))).toBe(true);
  expect(Number(response.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  await expect(notes.getByRole("article")).toHaveCount(2);
});

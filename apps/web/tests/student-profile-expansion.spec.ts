import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const origin = process.env.COURSES_PROFILE_EXPANSION_ORIGIN;
const credentialsFile = process.env.COURSES_PROFILE_EXPANSION_CREDENTIALS;
const queryLog = process.env.COURSES_PROFILE_EXPANSION_QUERY_LOG;
test.skip(!origin || !credentialsFile || !queryLog, "Requires an isolated two-center PostgreSQL fixture and measured Next.js proxy.");
test.setTimeout(120_000);

const credentials = credentialsFile ? JSON.parse(readFileSync(credentialsFile, "utf8")) : {};

async function signIn(page: Page) {
  await page.goto(`${origin}/login`);
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
    .filter(row => row.path.startsWith(`/api/v1/center/students/${studentId}`));
  expect(reads.length, "SSR must make a measured student read").toBeGreaterThan(0);
  for (const read of reads) {
    expect(Number.isInteger(read.count), `Missing SQL counter for ${read.path}`).toBe(true);
    expect(read.count!, `SQL count for ${read.path}`).toBeLessThanOrEqual(6);
  }
  expect(reads.reduce((total, read) => total + read.count!, 0), "Combined student SSR reads").toBeLessThanOrEqual(6);
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
  console.log(`Profile expansion SSR: ${JSON.stringify(measurements)}`);
});

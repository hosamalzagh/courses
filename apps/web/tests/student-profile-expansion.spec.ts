import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const origin = process.env.COURSES_PROFILE_EXPANSION_ORIGIN;
const credentialsFile = process.env.COURSES_PROFILE_EXPANSION_CREDENTIALS;
const queryLog = process.env.COURSES_PROFILE_EXPANSION_QUERY_LOG;
const databasePort = process.env.COURSES_PROFILE_EXPANSION_DB_PORT;
const image = { name: "student.png", mimeType: "image/png", buffer: Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAHUlEQVQ4jWMUSbFhIBcwka1zVPOo5lHNo5qpohkAvIEA3Cu5xEYAAAAASUVORK5CYII=",
  "base64",
) };
test.skip(!origin || !credentialsFile || !queryLog || databasePort !== "5558",
  "Requires an isolated two-center PostgreSQL fixture on port 5558 and measured Next.js proxy.");
test.setTimeout(120_000);

const credentials = credentialsFile ? JSON.parse(readFileSync(credentialsFile, "utf8")) : {};

async function signIn(page: Page, host = origin!, identity: "alpha" | "staff" = "alpha") {
  await page.goto(`${host}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials[identity].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials[identity].password);
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

function assertMeasuredPage(after: number, studentId: string, requireStudentRead = true) {
  const reads = readFileSync(queryLog!, "utf8").trim().split("\n").filter(Boolean).slice(after)
    .map(row => JSON.parse(row) as { path: string; count: number | null; ms: number | null })
    .filter(row => row.path.startsWith("/api/v1/center/"));
  if (requireStudentRead) expect(reads.some(read => read.path.startsWith(`/api/v1/center/students/${studentId}`)),
    "SSR must make a measured student read").toBe(true);
  for (const read of reads) {
    expect(Number.isInteger(read.count), `Missing SQL counter for ${read.path}`).toBe(true);
    expect(read.count!, `SQL count for ${read.path}`).toBeLessThanOrEqual(6);
    expect(Number.isFinite(read.ms) && read.ms! >= 0, `Missing SQL duration for ${read.path}`).toBe(true);
  }
  expect(reads.reduce((total, read) => total + read.count!, 0), "Combined center SSR reads").toBeLessThanOrEqual(6);
  return reads.map(read => ({ path: read.path, count: read.count!, ms: read.ms! }));
}

test("one authorized profile keeps study, attendance, suspension and finance together across measured tabs", async ({ page, browser }) => {
  await signIn(page);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branch = workspace.branches[0].id as number;
  const centerId = workspace.center.id as string;
  const unique = crypto.randomUUID().slice(0, 8);

  const course = await write(page, "courses", { branch_id: branch, name: `Acceptance ${unique}`, request_id: crypto.randomUUID() });
  expect(course.status).toBe(201);
  const stage = await write(page, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
  expect(stage.status).toBe(201);
  const level = await write(page, `stages/${stage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(),
    lectures: [{ number: 1, content: "Required", planned_hours: 1 }, { number: 2, content: "Required next", planned_hours: 1 }] });
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
  const groupId = group.body.group.id as string;
  const scheduled = new Date(Date.now() + 14 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
  const session = await write(page, `groups/${groupId}/sessions`, { kind: "single", revision: group.body.group.revision,
    start_at: scheduled, plan_lecture_number: 1, request_id: crypto.randomUUID() });
  expect(session.status).toBe(201);
  const sessionId = session.body.sessions[0].id as string;
  const nextScheduled = new Date(Date.now() + 15 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
  const secondSession = await write(page, `groups/${groupId}/sessions`, { kind: "single", revision: session.body.group_revision,
    start_at: nextScheduled, plan_lecture_number: 2, request_id: crypto.randomUUID() });
  expect(secondSession.status).toBe(201);
  const secondSessionId = secondSession.body.sessions[0].id as string;
  expect((await write(page, `groups/${groupId}/start`, { revision: secondSession.body.group_revision })).status).toBe(200);
  for (const id of [centerId, groupId, sessionId, secondSessionId]) expect(id).toMatch(/^[a-f0-9-]{36}$/);
  execFileSync("psql", ["-h", "127.0.0.1", "-p", databasePort!, "-U", "postgres", "-d", `courses_center_${centerId}`,
    "-c", `UPDATE study_groups SET started_at = now() - interval '2 days' WHERE id = '${groupId}'; UPDATE study_sessions SET scheduled_at = now() - interval '26 hours' WHERE id = '${sessionId}'; UPDATE study_sessions SET scheduled_at = now() - interval '25 hours' WHERE id = '${secondSessionId}'`], { stdio: "ignore" });
  const attendanceRoute = `groups/${groupId}/sessions/${sessionId}/attendance`;
  const roster = await (await page.request.get(`${origin}/api/v1/center/${attendanceRoute}`)).json();
  expect((await write(page, attendanceRoute, { attempt_id: attempt.body.attempt.id, status: "counted",
    revision: roster.session.revision, request_id: crypto.randomUUID() })).status).toBe(201);
  const secondAttendanceRoute = `groups/${groupId}/sessions/${secondSessionId}/attendance`;
  const secondRoster = await (await page.request.get(`${origin}/api/v1/center/${secondAttendanceRoute}`)).json();
  expect((await write(page, `groups/${groupId}/sessions/${secondSessionId}/close`, {
    revision: secondRoster.session.revision, request_id: crypto.randomUUID(),
  })).status).toBe(200);
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
    { path: "?tab=attendance", text: "حضور محتسب" },
    { path: "?tab=attachments", text: "لا توجد مرفقات متاحة ضمن صلاحياتك." },
    { path: "?tab=custom-history", text: "لا يوجد تاريخ متاح ضمن صلاحياتك." },
    { path: "?tab=notes", text: `متابعة مالية ${unique}` },
    { path: "/enrollments", text: `Group ${unique}` },
    { path: "/account", text: "30.00 EGP" },
  ];
  const measurements: { route: string; state: string; reads: { path: string; count: number; ms: number }[] }[] = [];
  for (const { path, text } of paths) {
    const url = `${origin}/admin/students/${studentId}${path}`;
    for (const state of ["cold", "warm"]) {
      const before = cursor();
      await page.goto(url, { waitUntil: "networkidle" });
      await expect(page.getByText(text, { exact: false }).first(), `${state} ${path}`).toBeVisible();
      if (!path) {
        const summary = page.getByRole("region", { name: "ملخص الطالب" });
        await expect(summary.getByRole("heading", { name: "الدراسة الحالية" })).toBeVisible();
        await expect(summary.getByText(`Group ${unique}`, { exact: false })).toBeVisible();
        await expect(summary.getByText("مديونية في الفروع المالية المصرح بها: 100.00 EGP", { exact: false })).toBeVisible();
        await expect(summary.getByText("غيابات مسجلة في المجموعات الحالية: ١", { exact: false })).toBeVisible();
      }
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
  for (const [label, expected, path] of [["الدراسة", `Group ${unique}`, "?tab=study"],
    ["الحضور والغياب", "حضور محتسب", "?tab=attendance"], ["الحساب المالي", "30.00 EGP", "/account"]] as const) {
    const before = cursor();
    await page.getByRole("navigation", { name: "أقسام ملف الطالب" }).getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(`${origin}/admin/students/${studentId}${path}`);
    await expect(page.getByText(expected, { exact: false }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    measurements.push({ route: `client:${label}`, state: "navigation", reads: assertMeasuredPage(before, studentId, false) });
  }
  page.off("request", countDocuments);
  expect(documentRequests, "Client navigation keeps the page shell").toBe(0);
  const statusRoute = `students/${studentId}/status`;
  const suspended = await write(page, statusRoute, { status: "suspended", reason: `قبول إيقاف ${unique}`,
    status_revision: 1, request_id: crypto.randomUUID() });
  expect(suspended.status).toBe(200);
  const suspendedAccount = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  const paymentWhileSuspended = await write(page, `students/${studentId}/payments`, { branch_id: branch, method: "cash",
    received_on: "2026-09-28", amount: "5.00", version: suspendedAccount.account.version, request_id: crypto.randomUUID() });
  expect(paymentWhileSuspended.status).toBe(201);
  let before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}?tab=attendance`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "حالة ملف الطالب: موقوف" })).toBeVisible();
  await expect(page.getByText("حضور محتسب", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("غياب مسجل", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "ملخص الطالب" }).getByText("مديونية في الفروع المالية المصرح بها: 100.00 EGP", { exact: false })).toBeVisible();
  measurements.push({ route: "suspended:attendance", state: "cold", reads: assertMeasuredPage(before, studentId) });
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}/account`, { waitUntil: "networkidle" });
  await expect(page.getByText("35.00 EGP", { exact: false }).first()).toBeVisible();
  measurements.push({ route: "suspended:account", state: "cold", reads: assertMeasuredPage(before, studentId) });
  const lifted = await write(page, statusRoute, { status: "active", reason: `قبول فك ${unique}`,
    status_revision: 2, request_id: crypto.randomUUID() });
  expect(lifted.status).toBe(200);
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}`, { waitUntil: "networkidle" });
  await expect(page.getByText(`السبب: قبول إيقاف ${unique}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`السبب: قبول فك ${unique}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "ملخص الطالب" }).getByText(`Group ${unique}`, { exact: false })).toBeVisible();
  measurements.push({ route: "active:history", state: "cold", reads: assertMeasuredPage(before, studentId) });

  // #43/#44: a changed group requirement and a newer plan applied to one student
  // must stay distinct in the student's historical profile after withdrawal.
  const requirement = { kind: "add", content: `Group only ${unique}`, reason: "قبول تغيير متطلبات المجموعة" };
  const requirementPreview = await write(page, `groups/${groupId}/requirements/preview`, requirement);
  expect(requirementPreview.status, JSON.stringify(requirementPreview.body)).toBe(200);
  const addedRequirement = await write(page, `groups/${groupId}/requirements`, {
    ...requirement, group_revision: requirementPreview.body.group_revision,
    preview_token: requirementPreview.body.preview_token, request_id: crypto.randomUUID(),
  });
  expect(addedRequirement.status, JSON.stringify(addedRequirement.body)).toBe(201);
  const newerPlan = await write(page, `levels/${level.body.level.id}/plan-versions`, {
    base_plan_version_id: level.body.level.plan.id, base_revision: level.body.level.plan.revision,
    lectures: [{ number: 1, content: "Required", planned_hours: 1 },
      { number: 2, content: "Required next", planned_hours: 1 },
      { number: 3, content: `New plan ${unique}`, planned_hours: 1 },
      { number: 4, content: `New plan extra ${unique}`, planned_hours: 1 }],
    request_id: crypto.randomUUID(),
  });
  expect(newerPlan.status, JSON.stringify(newerPlan.body)).toBe(201);
  const planChange = { target_plan_version_id: newerPlan.body.plan.id,
    attempt_ids: [attempt.body.attempt.id], reason: "قبول إصدار الخطة الأحدث لطالب واحد" };
  const planPreview = await write(page, `groups/${groupId}/plan-applications/preview`, planChange);
  expect(planPreview.status, JSON.stringify(planPreview.body)).toBe(200);
  const appliedPlan = await write(page, `groups/${groupId}/plan-applications`, {
    ...planChange, group_revision: planPreview.body.group_revision,
    preview_token: planPreview.body.preview_token, request_id: crypto.randomUUID(),
  });
  expect(appliedPlan.status, JSON.stringify(appliedPlan.body)).toBe(201);
  enrollment = await (await page.request.get(`${origin}/api/v1/center/${enrollments}`)).json();
  expect(enrollment.attempts[0].plan_version_id).toBe(newerPlan.body.plan.id);
  expect(enrollment.attempts[0].requirements_count).toBe(4);
  const todayCairo = new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
  const withdrawn = await write(page, `${enrollments}/${attempt.body.attempt.id}/withdraw`, {
    withdrawn_on: todayCairo, reason: "قبول حفظ تاريخ الدراسة بعد التعديل",
    revision: enrollment.attempts[0].revision, request_id: crypto.randomUUID(),
  });
  expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
  enrollment = await (await page.request.get(`${origin}/api/v1/center/${enrollments}`)).json();
  expect(enrollment.attempts[0].status).toBe("withdrawn");
  expect(enrollment.attempts[0].plan_version_id).toBe(newerPlan.body.plan.id);
  expect(enrollment.attempts[0].requirements_count).toBe(4);
  const coverage = await (await page.request.get(`${origin}/api/v1/center/groups/${groupId}/coverage`)).json();
  expect(coverage.group.required_count).toBe(3);
  expect(coverage.students.find((row: { attempt_id: string }) => row.attempt_id === attempt.body.attempt.id).required_count).toBe(4);
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}?tab=study`, { waitUntil: "networkidle" });
  await expect(page.getByText("انسحب من المحاولة")).toBeVisible();
  measurements.push({ route: "withdrawn:study", state: "cold", reads: assertMeasuredPage(before, studentId) });
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}/enrollments`, { waitUntil: "networkidle" });
  const historicalRow = page.getByRole("table", { name: "محاولات الدراسة" }).getByRole("row", { name: new RegExp(`Group ${unique}`) });
  await expect(historicalRow.getByRole("cell").nth(4)).toHaveText("٤");
  measurements.push({ route: "withdrawn:enrollments", state: "cold", reads: assertMeasuredPage(before, studentId) });

  // #54: a fee settlement, refund, payment correction and event note must flow
  // through the same profile while preserving financial scope and SQL bounds.
  const financialBefore = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  const feeId = financialBefore.fees.find((fee: { attempt_id: string }) => fee.attempt_id === attempt.body.attempt.id).id as string;
  const feeDetail = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/fees/${feeId}/adjustments?new_due=80.00`)).json();
  const settled = await write(page, `students/${studentId}/fees/${feeId}/adjustments`, {
    new_due: "80.00", reason: "قبول تسوية رسوم الانسحاب", replaces_adjustment_id: null,
    version: feeDetail.version, request_id: crypto.randomUUID(),
  });
  expect(settled.status, JSON.stringify(settled.body)).toBe(201);
  const refundRoute = `students/${studentId}/payments/${payment.body.payment.id}/refunds`;
  const refundDetail = await (await page.request.get(`${origin}/api/v1/center/${refundRoute}`)).json();
  const refunded = await write(page, refundRoute, { amount: "10.00", refunded_on: todayCairo,
    reason: "قبول استرداد جزء من الدفعة", version: refundDetail.version, request_id: crypto.randomUUID() });
  expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);
  const correctionRoute = `students/${studentId}/payments/${payment.body.payment.id}/corrections`;
  const correctionDetail = await (await page.request.get(`${origin}/api/v1/center/${correctionRoute}`)).json();
  const corrected = await write(page, correctionRoute, { correct_amount: "40.00", allocations: [],
    reason: "قبول تصحيح مبلغ الدفعة", version: correctionDetail.version, request_id: crypto.randomUUID() });
  expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
  const correctionNote = `تصحيح مالي مهم ${unique}`;
  const noted = await write(page, `students/${studentId}/financial-events/payment_correction/${corrected.body.reversal.id}/note`, {
    body: correctionNote, important: true, revision: 0, request_id: crypto.randomUUID(),
  }, "PUT");
  expect(noted.status, JSON.stringify(noted.body)).toBe(201);
  const afterMoney = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  expect(afterMoney.account.received_total).toBe("45.00");
  expect(afterMoney.account.refunded_total).toBe("10.00");
  expect(afterMoney.account.available_balance).toBe("35.00");
  expect(afterMoney.account.due_total).toBe("80.00");
  expect(afterMoney.account.debt).toBe("80.00");
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("region", { name: "ملخص الطالب" }).getByText("مديونية في الفروع المالية المصرح بها: 80.00 EGP", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: correctionNote })).toBeVisible();
  measurements.push({ route: "settled:profile", state: "cold", reads: assertMeasuredPage(before, studentId) });
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}?tab=notes`, { waitUntil: "networkidle" });
  await expect(page.getByRole("region", { name: "ملاحظات أحداث الطالب" }).getByText(correctionNote)).toBeVisible();
  measurements.push({ route: "corrected:notes", state: "cold", reads: assertMeasuredPage(before, studentId) });
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}/account`, { waitUntil: "networkidle" });
  await expect(page.getByText("80.00 EGP", { exact: false }).first()).toBeVisible();
  measurements.push({ route: "corrected:account", state: "cold", reads: assertMeasuredPage(before, studentId) });
  const allocationRoute = `students/${studentId}/payments/${payment.body.payment.id}/allocations`;
  const allocationOptions = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/payments/${payment.body.payment.id}/allocation-options`)).json();
  const allocated = await write(page, allocationRoute, { targets: [{ attempt_id: attempt.body.attempt.id, amount: "20.00" }],
    version: allocationOptions.version, request_id: crypto.randomUUID() });
  expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);
  expect((await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json()).account.debt).toBe("60.00");
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("region", { name: "ملخص الطالب" }).getByText("مديونية في الفروع المالية المصرح بها: 60.00 EGP", { exact: false })).toBeVisible();
  measurements.push({ route: "allocated:profile", state: "cold", reads: assertMeasuredPage(before, studentId) });
  const allocationId = allocated.body.allocations[0].id as string;
  const allocationCorrection = await write(page, `students/${studentId}/allocations/${allocationId}/corrections`, {
    target_attempt_id: null, reason: "قبول تصحيح تخصيص الدفعة", version: allocated.body.version,
    request_id: crypto.randomUUID(),
  });
  expect(allocationCorrection.status, JSON.stringify(allocationCorrection.body)).toBe(201);
  const correctedAccount = await (await page.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).json();
  expect(correctedAccount.account.debt).toBe("80.00");
  expect(correctedAccount.account.available_balance).toBe("35.00");
  before = cursor();
  await page.goto(`${origin}/admin/students/${studentId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("region", { name: "ملخص الطالب" }).getByText("مديونية في الفروع المالية المصرح بها: 80.00 EGP", { exact: false })).toBeVisible();
  measurements.push({ route: "allocation-corrected:profile", state: "cold", reads: assertMeasuredPage(before, studentId) });
  const registration = await browser.newPage();
  try {
    await signIn(registration, origin!, "staff");
    expect((await registration.request.get(`${origin}/api/v1/center/students/${studentId}/account`)).status()).toBe(404);
    expect((await registration.request.get(`${origin}/api/v1/center/students/${studentId}/financial-events/payment_correction/${corrected.body.reversal.id}/note`)).status()).toBe(404);
    before = cursor();
    await registration.goto(`${origin}/admin/students/${studentId}`, { waitUntil: "networkidle" });
    await expect(registration.getByText(`قبول التوسعة ${unique}`, { exact: false }).first()).toBeVisible();
    await expect(registration.getByText(correctionNote)).toHaveCount(0);
    await expect(registration.getByText("مديونية في الفروع المالية المصرح بها", { exact: false })).toHaveCount(0);
    measurements.push({ route: "registration:profile", state: "cold", reads: assertMeasuredPage(before, studentId) });
  } finally {
    await registration.close();
  }
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
  const rawCount = response.headers()["x-courses-query-count"];
  expect(rawCount).toMatch(/^\d+$/);
  expect(Number.isSafeInteger(Number(rawCount))).toBe(true);
  expect(Number(rawCount)).toBeLessThanOrEqual(6);
  await expect(notes.getByRole("article")).toHaveCount(2);
});

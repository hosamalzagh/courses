import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const origin = process.env.COURSES_ISSUE70_BROWSER_URL;
test.skip(!origin, "Requires the isolated issue70 database and browser fixture.");
test.setTimeout(90_000);
const credentialsFile = path.resolve(process.cwd(), "../api/storage/app/private/issue70-browser-credentials.json");

async function write(page: Page, route: string, payload: object, method = "POST") {
  return page.evaluate(async ({ route, payload, method }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${route}`, {
      method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { route, payload, method });
}

function setSessionTime(centerId: string, groupId: string, sessionId: string, first: boolean) {
  const expression = first ? "now('Africa/Cairo')->subMinutes(2)" : "now('Africa/Cairo')->addSeconds(2)";
  execFileSync("php85", ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (config('database.connections.central.database') !== 'courses_test_central_issue70') throw new \RuntimeException('Unexpected database');
    \App\Models\Center::findOrFail(getenv('COURSES_TEST_CENTER'))->run(function () {
      if (getenv('COURSES_TEST_FIRST') === '1') \Illuminate\Support\Facades\DB::table('study_groups')->where('id', getenv('COURSES_TEST_GROUP'))->update(['started_at' => now('Africa/Cairo')->subDay()->format('Y-m-d H:i:s.uP')]);
      \Illuminate\Support\Facades\DB::table('study_sessions')->where('id', getenv('COURSES_TEST_SESSION'))->update(['scheduled_at' => ${expression}->format('Y-m-d H:i:s.uP')]);
    });
  `], {
    cwd: path.resolve(process.cwd(), "../api"),
    env: { ...process.env, DB_DATABASE: "courses_test_central_issue70", COURSES_TEST_CENTER: centerId,
      COURSES_TEST_GROUP: groupId, COURSES_TEST_SESSION: sessionId, COURSES_TEST_FIRST: first ? "1" : "0" },
  });
}

test("suspended student stays visible without attendance or automatic absence across close and lift", async ({ page }) => {
  const credentials = JSON.parse(readFileSync(credentialsFile, "utf8")) as { email: string; password: string };
  await page.goto(`${origin}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials.email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials.password);
  await expect(page.getByRole("button", { name: "دخول المركز", exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/admin`);
  const workspace = await (await page.request.get(`${origin}/api/v1/center/student-workspace`)).json();
  const branchId = workspace.branches[0].id as number;
  const centerId = workspace.center.id as string;
  const suffix = crypto.randomUUID().slice(0, 8);
  const course = await write(page, "courses", { branch_id: branchId, name: `Suspension ${suffix}`, request_id: crypto.randomUUID() });
  expect(course.status).toBe(201);
  const stage = await write(page, `courses/${course.body.course.id}/stages`, { name: "Stage", request_id: crypto.randomUUID() });
  expect(stage.status).toBe(201);
  const level = await write(page, `stages/${stage.body.stage.id}/levels`, { name: "Level", request_id: crypto.randomUUID(),
    lectures: [{ number: 1, content: "First", planned_hours: 1 }, { number: 2, content: "Second", planned_hours: 1 },
      { number: 3, content: "Race", planned_hours: 1 }] });
  expect(level.status).toBe(201);
  const instructor = await write(page, "instructors", { name: `Instructor ${suffix}`, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(instructor.status).toBe(201);
  const group = await write(page, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id,
    name: `Group ${suffix}`, approved_price: "0.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() });
  expect(group.status).toBe(201);
  const groupId = group.body.group.id as string;
  const start = new Date(Date.now() + 14 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
  const sessions = await write(page, `groups/${groupId}/sessions`, { kind: "weekly", revision: 1,
    start_at: start, count: 2, interval_weeks: 1, request_id: crypto.randomUUID() });
  expect(sessions.status).toBe(201);
  const studentName = `طالب الإيقاف ${suffix}`;
  const student = await write(page, "students", { name: studentName, branch_ids: [branchId], request_id: crypto.randomUUID() });
  expect(student.status).toBe(201);
  const account = await (await page.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/account`)).json();
  if (!account.account.currency) {
    expect((await write(page, "financial-currency", { currency: "EGP", revision: account.account.currency_revision }, "PATCH")).status).toBe(200);
  }
  const enrollmentContext = await (await page.request.get(`${origin}/api/v1/center/students/${student.body.student.id}/enrollments`)).json();
  const joinedOn = new Date().toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
  const enrollment = await write(page, `students/${student.body.student.id}/enrollments`, {
    group_id: groupId, group_revision: sessions.body.group_revision, currency_revision: enrollmentContext.student.currency_revision,
    joined_on: joinedOn, discount: "0.00", discount_reason: null, version: enrollmentContext.student.version,
    request_id: crypto.randomUUID(),
  });
  expect(enrollment.status).toBe(201);
  const started = await write(page, `groups/${groupId}/start`, { revision: sessions.body.group_revision });
  expect(started.status).toBe(200);
  const firstId = sessions.body.sessions[0].id as string;
  const secondId = sessions.body.sessions[1].id as string;
  setSessionTime(centerId, groupId, firstId, true);
  const firstRoute = `groups/${groupId}/sessions/${firstId}/attendance`;
  const secondRoute = `groups/${groupId}/sessions/${secondId}/attendance`;
  const first = await (await page.request.get(`${origin}/api/v1/center/${firstRoute}`)).json();
  expect((await write(page, firstRoute, { attempt_id: enrollment.body.attempt.id, status: "counted",
    revision: first.session.revision, request_id: crypto.randomUUID() })).status).toBe(201);
  expect((await write(page, `groups/${groupId}/sessions/${firstId}/close`, {
    revision: first.session.revision + 1, request_id: crypto.randomUUID(),
  })).status).toBe(200);
  const stale = await (await page.request.get(`${origin}/api/v1/center/${secondRoute}`)).json();
  expect((await write(page, `students/${student.body.student.id}/status`, { status: "suspended", reason: "إيقاف قبول الحضور",
    status_revision: 1, request_id: crypto.randomUUID() })).status).toBe(200);
  setSessionTime(centerId, groupId, secondId, false);
  await expect.poll(async () => (await (await page.request.get(`${origin}/api/v1/center/${secondRoute}`)).json()).has_started).toBe(true);
  const url = `${origin}/admin/${secondRoute}`;
  const beforeSsr = readFileSync("/tmp/courses-issue70-reads.jsonl", "utf8").trim().split("\n").length;
  const html = await (await page.request.get(url)).text();
  expect(html).toContain(studentName);
  expect(html).toContain("مستبعد بسبب الإيقاف");
  const ssrReads = readFileSync("/tmp/courses-issue70-reads.jsonl", "utf8").trim().split("\n").slice(beforeSsr)
    .map(line => JSON.parse(line) as { path: string; count: number | null })
    .filter(read => read.path.startsWith(`/api/v1/center/${secondRoute}`));
  expect(ssrReads.length).toBeGreaterThan(0);
  expect(ssrReads.every(read => Number.isInteger(read.count) && read.count! <= 6)).toBe(true);
  await page.goto(url);
  const row = page.getByRole("row", { name: new RegExp(studentName) });
  await expect(row).toContainText("مستبعد بسبب الإيقاف");
  await expect(row.getByRole("button", { name: "تسجيل الحضور" })).toHaveCount(0);
  const rejected = await write(page, secondRoute, { attempt_id: enrollment.body.attempt.id, status: "counted",
    revision: stale.session.revision, request_id: crypto.randomUUID() });
  expect(rejected.status).toBe(409);
  expect(rejected.body.code).toBe("student_suspended_for_session");
  await page.getByRole("button", { name: "إغلاق كشف المحاضرة" }).click();
  await page.getByRole("button", { name: "تأكيد الإغلاق" }).click();
  await expect(row).toContainText("مستبعد بسبب الإيقاف");
  expect((await write(page, `students/${student.body.student.id}/status`, { status: "active", reason: "انتهاء الإيقاف",
    status_revision: 2, request_id: crypto.randomUUID() })).status).toBe(200);
  await page.reload();
  await expect(row).toContainText("مستبعد بسبب الإيقاف");
  await expect(row).toContainText("إلى");
  const firstHistory = await (await page.request.get(`${origin}/api/v1/center/${firstRoute}`)).json();
  expect(firstHistory.students[0].status).toBe("counted");
  const secondHistory = await page.request.get(`${origin}/api/v1/center/${secondRoute}`);
  expect(Number(secondHistory.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
  expect((await secondHistory.json()).students[0].status).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.getByRole("button", { name: "القائمة" }).click();
  await page.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const third = await write(page, `groups/${groupId}/sessions`, { kind: "single", revision: started.body.group.revision,
    start_at: new Date(Date.now() + 28 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T"),
    plan_lecture_number: 3, request_id: crypto.randomUUID() });
  expect(third.status).toBe(201);
  const thirdId = third.body.sessions[0].id as string;
  setSessionTime(centerId, groupId, thirdId, true);
  const thirdRoute = `groups/${groupId}/sessions/${thirdId}/attendance`;
  const raceRevision = (await (await page.request.get(`${origin}/api/v1/center/${thirdRoute}`)).json()).session.revision;
  const [suspension, recording] = await Promise.all([
    write(page, `students/${student.body.student.id}/status`, { status: "suspended", reason: "طلب متزامن مع الحضور",
      status_revision: 3, request_id: crypto.randomUUID() }),
    write(page, thirdRoute, { attempt_id: enrollment.body.attempt.id, status: "counted",
      revision: raceRevision, request_id: crypto.randomUUID() }),
  ]);
  expect(suspension.status).toBe(200);
  expect([201, 409]).toContain(recording.status);
  const raceResult = await (await page.request.get(`${origin}/api/v1/center/${thirdRoute}`)).json();
  expect(raceResult.students[0].status).toBe(recording.status === 201 ? "counted" : null);
});

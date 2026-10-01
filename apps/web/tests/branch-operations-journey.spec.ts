import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";


const apiDirectory = path.resolve(process.cwd(), "../api");
const php = process.env.COURSES_PHP_BIN ?? "php85";
const suffix = randomBytes(5).toString("hex");
const centerSlug = "op147-" + suffix;
const origin = "http://" + centerSlug + ".courses.test";
const email = `operations-${suffix}@courses.test`;
const password = randomBytes(18).toString("hex");
const names = [`فرع التحقق الشمالي ${suffix}`, `فرع التحقق الجنوبي ${suffix}`];
function fixture(code: string): string {
  return execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Only local browser fixtures');
    $center = \App\Models\Center::where('slug', getenv('OPERATIONS_SCENARIO_SLUG'))->first();
    $email = getenv('OPERATIONS_TEST_EMAIL');
    $user = \App\Models\User::where('email', $email)->first();
  ` + code], { cwd: apiDirectory, env: { ...process.env, OPERATIONS_TEST_EMAIL: email, OPERATIONS_TEST_PASSWORD: password, OPERATIONS_TEST_SUFFIX: suffix, OPERATIONS_SCENARIO_SLUG: centerSlug }, stdio: "pipe", encoding: "utf8" });
}
async function login(page: Page) {
  await page.goto(`${origin}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
  await page.getByRole("textbox", { name: "كلمة المرور" }).fill(password);
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = page.waitForResponse(response => response.url().endsWith("/api/v1/center/auth/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "دخول المركز" }).click();
    const response = await pending;
    if (response.status() !== 429) { expect(response.ok()).toBe(true); break; }
    await page.waitForTimeout((Number(response.headers()["retry-after"] ?? "60") + 1) * 1000);
    await page.getByRole("textbox", { name: "كلمة المرور" }).fill(password);
  }
}
async function choose(page: Page, name: string) {
  await expect(page).toHaveURL(url => url.pathname === "/admin/workspaces", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "اختيار مساحة العمل", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator("[data-workspace-name]")).toHaveText(name);
  await expect.poll(() => new URL(page.url()).searchParams.get("workspace")).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.locator(".route-progress")).toHaveCount(0);
}
function cursor() { return Number(fixture(String.raw`echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;`).trim()); }

test.beforeAll(() => {
  fixture(String.raw`
    \Illuminate\Support\Facades\Mail::fake();
    $center = \App\Models\Center::create(['name'=>'Operations scenario '.getenv('OPERATIONS_TEST_SUFFIX'), 'slug'=>getenv('OPERATIONS_SCENARIO_SLUG'), 'plan'=>'starter', 'owner_email'=>$email]);
    $center->domains()->create(['domain'=>getenv('OPERATIONS_SCENARIO_SLUG').'.courses.test']);
    (new \App\Jobs\ProvisionCenter($center->id))->handle();
    if ($center->fresh()->provisioning_status !== 'active') throw new \RuntimeException('Fixture center provisioning failed');
    $user = \App\Models\User::factory()->create(['name'=>'Operations owner', 'email'=>$email, 'email_verified_at'=>now(), 'password'=>getenv('OPERATIONS_TEST_PASSWORD')]);
    \App\Models\CenterMembership::create(['user_id'=>$user->id, 'tenant_id'=>$center->id, 'status'=>'active']);
    $center->run(function () use ($user) {
      \Illuminate\Support\Facades\DB::table('center_grants')->insert(['user_id'=>$user->id,'role'=>'center_owner','created_at'=>now(),'updated_at'=>now()]);
      \Illuminate\Support\Facades\DB::table('center_settings')->where('id',1)->update(['financial_currency'=>'EGP']);
      foreach (['فرع التحقق الشمالي ', 'فرع التحقق الجنوبي '] as $index=>$name) {
        \Illuminate\Support\Facades\DB::table('branches')->insert(['name'=>$name.getenv('OPERATIONS_TEST_SUFFIX'),'slug'=>'scenario-'.$index,'created_at'=>now(),'updated_at'=>now()]);
      }
    });
  `);
});
test.afterAll(() => {
  fixture(String.raw`
    if ($center && $center->slug === getenv('OPERATIONS_SCENARIO_SLUG') && str_starts_with($center->slug,'op147-')) {
      $name = $center->database()->getName();
      if (!preg_match('/^courses_center_[a-f0-9-]{36}$/', $name)) throw new \RuntimeException('Unexpected disposable database');
      tenancy()->end();
      \Illuminate\Support\Facades\DB::purge('tenant');
      \Illuminate\Support\Facades\DB::connection('provisioning')->statement('DROP DATABASE IF EXISTS "'.$name.'" WITH (FORCE)');
      \Illuminate\Support\Facades\DB::connection('central')->table('center_invitations')->where('tenant_id',$center->id)->delete();
      \App\Models\CenterMembership::where('tenant_id',$center->id)->delete();
      $center->domains()->delete();
      \Illuminate\Support\Facades\DB::connection('central')->table('tenants')->where('id',$center->id)->delete();
      if ($user && $user->email === $email) $user->delete();
    }
  `);
});

async function write(page: Page, route: string, payload: object, workspace: string, method = "POST") {
  return page.evaluate(async ({ route, payload, workspace, method }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch("/api/v1/center/" + route, { method, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Courses-Workspace": workspace, "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, { route, payload, workspace, method });
}
async function read(page: Page, route: string, workspace: string) {
  const response = await page.request.get(origin + "/api/v1/center/" + route, { headers: { "X-Courses-Workspace": workspace } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function group(page: Page, branchId: number, label: string, workspace: string) {
  const course = await write(page, "courses", { branch_id: branchId, name: "Scenario " + label, request_id: crypto.randomUUID() }, workspace);
  expect(course.status).toBe(201);
  const stage = await write(page, "courses/" + course.body.course.id + "/stages", { name: "Stage", request_id: crypto.randomUUID() }, workspace);
  expect(stage.status).toBe(201);
  const level = await write(page, "stages/" + stage.body.stage.id + "/levels", { name: "Level", lectures: [{ number: 1, content: "Lecture " + label, planned_hours: 1 }], request_id: crypto.randomUUID() }, workspace);
  expect(level.status).toBe(201);
  const instructor = await write(page, "instructors", { name: "Scenario teacher " + label, branch_ids: [branchId], request_id: crypto.randomUUID() }, workspace);
  expect(instructor.status).toBe(201);
  const created = await write(page, "groups", { level_id: level.body.level.id, plan_version_id: level.body.level.plan.id, name: "Scenario group " + label,
    approved_price: "100.00", instructor_ids: [instructor.body.instructor.id], request_id: crypto.randomUUID() }, workspace);
  expect(created.status).toBe(201);
  return { course: course.body.course, group: created.body.group, plan: level.body.level.plan };
}
function reads(since: number) {
  return JSON.parse(fixture(String.raw`
    echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type','request')->where('sequence','>', ` + since + String.raw`)
      ->whereRaw("content::jsonb->'headers'->>'host' = ?", [getenv('OPERATIONS_SCENARIO_SLUG').'.courses.test'])
      ->whereRaw("content::jsonb->>'uri' LIKE '%api/v1/center/%'")
      ->whereRaw("content::jsonb->'headers'->>'x-courses-workspace' IS NOT NULL")
      ->pluck('content')->map(fn ($content) => ['path'=>json_decode($content,true)['uri'],
        'count'=>json_decode($content,true)['response_headers']['x-courses-query-count'] ?? null])->toJson();
  `)) as { path: string; count: string | null }[];
}
async function boundedSsr(page: Page, path: string, workspace: string) {
  const before = cursor();
  const response = await page.goto(origin + path + (path.includes("?") ? "&" : "?") + "workspace=" + workspace);
  expect(response?.status()).toBe(200);
  await expect.poll(() => reads(before).length, { timeout: 15_000 }).toBeGreaterThan(0);
  for (const row of reads(before)) { expect(row.count).toMatch(/^\d+$/); expect(Number(row.count)).toBeLessThanOrEqual(6); }
  expect(reads(before).reduce((sum, row) => sum + Number(row.count), 0)).toBeLessThanOrEqual(6);
  console.log("147 scenario SSR", reads(before));
}

test("student registration, group session attendance and absence, unified account payment, and cross-branch transfer stay in source workspace", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await choose(page, "إدارة المركز");
  const centerId = new URL(page.url()).searchParams.get("workspace")!;
  const workspace = await read(page, "student-workspace", centerId);
  const north = workspace.branches.find((branch: { name: string }) => branch.name === names[0]).id;
  const south = workspace.branches.find((branch: { name: string }) => branch.name === names[1]).id;
  const source = await group(page, north, "north", centerId);
  const target = await group(page, south, "south", centerId);
  const first = await write(page, "students", { name: "Scenario learner", branch_ids: [north, south], request_id: crypto.randomUUID() }, centerId);
  const second = await write(page, "students", { name: "Scenario absent", branch_ids: [north], request_id: crypto.randomUUID() }, centerId);
  expect(first.status).toBe(201); expect(second.status).toBe(201);
  const studentId = first.body.student.id;
  const date = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Africa/Cairo" });
  for (const branchId of [north, south]) {
    const account = await read(page, "students/" + studentId + "/account", centerId);
    const payment = await write(page, "students/" + studentId + "/payments", { branch_id: branchId, method: "cash", received_on: date(-3),
      amount: "10.00", version: account.account.version, request_id: crypto.randomUUID() }, centerId);
    expect(payment.status).toBe(201);
  }
  const absentContext = await read(page, "students/" + second.body.student.id + "/enrollments", centerId);
  expect((await write(page, "students/" + second.body.student.id + "/enrollments", {
    group_id: source.group.id, group_revision: source.group.revision, currency_revision: absentContext.student.currency_revision,
    joined_on: date(-3), discount: "0.00", discount_reason: null, version: absentContext.student.version, request_id: crypto.randomUUID(),
  }, centerId)).status).toBe(201);
  const start = new Date(Date.now() + 14 * 86_400_000).toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }).slice(0, 16).replace(" ", "T");
  const session = await write(page, "groups/" + source.group.id + "/sessions", { kind: "single", revision: source.group.revision,
    start_at: start, plan_lecture_number: 1, request_id: crypto.randomUUID() }, centerId);
  expect(session.status).toBe(201);
  expect((await write(page, "groups/" + source.group.id + "/start", { revision: session.body.group_revision }, centerId)).status).toBe(200);
  fixture(String.raw`
    $center->run(function () {
      \Illuminate\Support\Facades\DB::table('study_groups')->where('name','Scenario group north')->update(['started_at'=>now()->subDays(3)]);
      \Illuminate\Support\Facades\DB::table('study_sessions')->update(['scheduled_at'=>now()->subDays(2)]);
    });
  `);
  const approved = await write(page, "content-equivalences", { source_plan_version_id: source.plan.id, target_plan_version_id: target.plan.id,
    source_lecture_ids: [source.plan.lectures[0].id], target_lecture_ids: [target.plan.lectures[0].id], reason: "Approved scenario transfer", request_id: crypto.randomUUID() }, centerId);
  expect(approved.status).toBe(201);
  await page.getByRole("link", { name: "تبديل مساحة العمل", exact: true }).click();
  await choose(page, names[0]);
  const northWorkspace = new URL(page.url()).searchParams.get("workspace")!;
  await boundedSsr(page, "/admin/students/" + studentId, northWorkspace);
  await page.getByRole("link", { name: "التسجيل ومحاولات الدراسة", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "المجموعة الأساسية" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "المجموعة الأساسية" }).getByRole("option", { name: target.group.name, exact: false })).toHaveCount(0);
  await page.getByRole("combobox", { name: "المجموعة الأساسية" }).selectOption(source.group.id);
  await page.getByLabel("تاريخ الانضمام الفعلي").fill(date(-3));
  await page.getByRole("button", { name: "تسجيل الطالب والرسوم", exact: true }).click();
  await expect(page.getByText("سُجلت المحاولة ورسومها معًا", { exact: false })).toBeVisible();
  const enrolled = await read(page, "students/" + studentId + "/enrollments", northWorkspace);
  const attemptId = enrolled.attempts[0].id;
  await boundedSsr(page, "/admin/students/" + studentId + "?tab=study", northWorkspace);
  await expect(page.getByRole("row", { name: /Scenario north/ })).toContainText(source.group.name);
  await page.getByRole("link", { name: "المجموعات الدراسية", exact: true }).click();
  await expect(page.getByRole("link", { name: target.group.name, exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: source.group.name, exact: true }).click();
  await expect(page.getByRole("link", { name: "كشف الحضور", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "كشف الحضور", exact: true }).click();
  await expect(page.getByRole("table", { name: "كشف الطلاب المستحقين", exact: true })).toBeVisible();
  const rosterRow = page.getByRole("row", { name: /Scenario learner/ });
  await rosterRow.getByRole("button", { name: "تسجيل الحضور", exact: true }).click();
  await page.getByRole("button", { name: "حاضر محتسب", exact: true }).click();
  await expect(rosterRow).toContainText("حاضر محتسب");
  await page.getByRole("button", { name: "إغلاق كشف المحاضرة", exact: true }).click();
  await page.getByRole("button", { name: "تأكيد الإغلاق", exact: true }).click();
  await expect(page.getByRole("row", { name: /Scenario absent/ })).toContainText("غائب");
  await boundedSsr(page, "/admin/absence-review?view=all&group_id=" + source.group.id, northWorkspace);
  await expect(page.getByRole("link", { name: /^Scenario absent ·/ })).toBeVisible();
  await expect(page.getByLabel("الفرع", { exact: true })).toHaveCount(0);
  await boundedSsr(page, "/admin/students/" + studentId + "/account", northWorkspace);
  await expect(page.getByText("نطاق الحساب: الفروع المصرح بها ماليًا", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "فرع الاستلام", exact: true })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "حركات الدفعات المقدمة", exact: true })).toContainText(names[0]);
  await expect(page.getByRole("table", { name: "حركات الدفعات المقدمة", exact: true })).toContainText(names[1]);
  await page.locator('input[id$="-received_on"]').fill(date(-1));
  await page.getByLabel("المبلغ (EGP)", { exact: true }).fill("5.00");
  const paid = page.waitForResponse(response => response.url().endsWith("/students/" + studentId + "/payments") && response.request().method() === "POST");
  await page.getByRole("button", { name: "تسجيل الدفعة", exact: true }).click();
  const payment = await paid;
  expect(payment.status()).toBe(201);
  expect(payment.request().postDataJSON().branch_id).toBe(north);
  const paidAccount = await read(page, "students/" + studentId + "/account", northWorkspace);
  expect(paidAccount.payments.some((entry: { amount: string; branch_id: number }) => entry.amount === "5.00" && entry.branch_id === north)).toBe(true);
  await expect(page.getByText("سُجلت الدفعة المقدمة", { exact: false })).toBeVisible();
  await boundedSsr(page, "/admin/students/" + studentId + "/enrollments", northWorkspace);
  await page.locator('[id$="-transfer-' + attemptId + '"]').click();
  const editor = page.getByRole("region", { name: "نقل الطالب بين المجموعات والفروع", exact: true });
  await expect(editor.getByLabel("مجموعة الوجهة").locator('option[value="' + target.group.id + '"]')).toBeAttached();
  await editor.getByLabel("مجموعة الوجهة").selectOption(target.group.id);
  await editor.getByLabel("تاريخ النقل الفعلي").fill(date(-1));
  await page.getByRole("button", { name: "معاينة النقل", exact: true }).click();
  await expect(editor.getByText(/متطلبات الوجهة/)).toBeVisible();
  await editor.getByLabel("سبب النقل").fill("Moved to authorized South destination");
  await page.getByRole("button", { name: "تأكيد النقل", exact: true }).click();
  await page.getByRole("button", { name: "نقل المحاولة", exact: true }).click();
  await expect(page.getByText("حُفظ النقل في المحاولة نفسها دون رسوم أو تخصيص جديد.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-workspace-name]")).toHaveText(names[0]);
  expect(new URL(page.url()).searchParams.get("workspace")).toBe(northWorkspace);
  await expect(page.locator('[id$="-transfer-' + attemptId + '"]')).toHaveCount(0);
  await page.getByRole("link", { name: "تبديل مساحة العمل", exact: true }).click();
  await choose(page, names[1]);
  const southWorkspace = new URL(page.url()).searchParams.get("workspace")!;
  await boundedSsr(page, "/admin/students/" + studentId + "?tab=study", southWorkspace);
  await expect(page.getByRole("row", { name: /Scenario south/ })).toContainText(target.group.name);
  await page.getByRole("link", { name: "تبديل مساحة العمل", exact: true }).click();
  await choose(page, names[0]);
  const copyWorkspace = new URL(page.url()).searchParams.get("workspace")!;
  // Page two is a controlled network seam; the real selected destination and preview stay authorized.
  await page.route("**/api/v1/center/courses/" + source.course.id + "/copy-destinations?*", async route => {
    const next = new URL(route.request().url()).searchParams.get("page") === "2";
    await route.fulfill({ json: { branches: next ? [{ id: 999999, name: "Paging option" }] : [{ id: south, name: names[1] }], has_more: !next } });
  });
  await page.goto(origin + "/admin/curriculum?tab=stages&course_id=" + source.course.id + "&workspace=" + copyWorkspace);
  await page.locator("[data-curriculum-details]").getByRole("button", { name: "إدارة الكورس: " + source.course.name, exact: true }).click();
  await page.getByRole("menuitem", { name: "نسخ المنهج إلى فرع", exact: true }).click();
  await expect(page.getByLabel("الفرع الوجهة")).toHaveValue(String(south));
  await page.getByRole("button", { name: "معاينة ما سيُنسخ", exact: true }).click();
  await expect(page.getByRole("button", { name: "تأكيد النسخ", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "الفروع التالية", exact: true }).click();
  await expect(page.getByLabel("الفرع الوجهة").getByRole("option", { name: "Paging option", exact: true })).toBeAttached();
  await expect(page.getByLabel("الفرع الوجهة")).toHaveValue(String(south));
  await expect(page.getByRole("button", { name: "تأكيد النسخ", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "الفروع السابقة", exact: true }).click();
  await expect(page.getByLabel("الفرع الوجهة").getByRole("option", { name: "Paging option", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("الفرع الوجهة")).toHaveValue(String(south));
  await expect(page.getByRole("button", { name: "تأكيد النسخ", exact: true })).toBeVisible();
});

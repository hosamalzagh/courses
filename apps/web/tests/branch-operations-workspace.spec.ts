import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const origin = "http://alpha.courses.test";
const apiDirectory = path.resolve(process.cwd(), "../api");
const php = process.env.COURSES_PHP_BIN ?? "php85";
const suffix = randomBytes(5).toString("hex");
const email = `operations-${suffix}@courses.test`;
const password = randomBytes(18).toString("hex");
const names = [`فرع التحقق الشمالي ${suffix}`, `فرع التحقق الجنوبي ${suffix}`];
function fixture(code: string): string {
  return execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Only local browser fixtures');
    $center = \App\Models\Center::where('slug', 'alpha')->firstOrFail();
    $email = getenv('OPERATIONS_TEST_EMAIL');
    $user = \App\Models\User::where('email', $email)->first();
  ` + code], { cwd: apiDirectory, env: { ...process.env, OPERATIONS_TEST_EMAIL: email, OPERATIONS_TEST_PASSWORD: password, OPERATIONS_TEST_SUFFIX: suffix }, stdio: "pipe", encoding: "utf8" });
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
function reads(since: number) {
  return JSON.parse(fixture(String.raw`
    echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'request')->where('sequence', '>', ` + since + String.raw`)
      ->whereRaw("content::jsonb->>'uri' LIKE '%student-workspace%'")
      ->whereRaw("content::jsonb->'headers'->>'host' = 'alpha.courses.test'")
      ->pluck('content')->map(fn ($content) => json_decode($content, true)['response_headers']['x-courses-query-count'] ?? null)->toJson();
  `)) as (string | null)[];
}

test.beforeAll(() => {
  fixture(String.raw`
    $user = \App\Models\User::factory()->create(['name'=>'Workspace Test', 'email'=>$email, 'email_verified_at'=>now(), 'password'=>getenv('OPERATIONS_TEST_PASSWORD')]);
    \App\Models\CenterMembership::create(['user_id'=>$user->id, 'tenant_id'=>$center->id, 'status'=>'active']);
    $center->run(function () use ($user) {
      foreach (['فرع التحقق الشمالي ', 'فرع التحقق الجنوبي '] as $index=>$name) {
        $id = \Illuminate\Support\Facades\DB::table('branches')->insertGetId(['name'=>$name.getenv('OPERATIONS_TEST_SUFFIX'), 'slug'=>'operations-'.getenv('OPERATIONS_TEST_SUFFIX').'-'.$index, 'created_at'=>now(), 'updated_at'=>now()]);
        \Illuminate\Support\Facades\DB::table('branch_grants')->insert(['user_id'=>$user->id, 'branch_id'=>$id, 'role'=>'registration', 'created_at'=>now(), 'updated_at'=>now()]);
      }
      $branches = \Illuminate\Support\Facades\DB::table('branches')->where('slug', 'like', 'operations-'.getenv('OPERATIONS_TEST_SUFFIX').'-%')->orderBy('id')->pluck('id');
      foreach ($branches as $branchId) {
        \Illuminate\Support\Facades\DB::table('branch_grants')->insert(['user_id'=>$user->id, 'branch_id'=>$branchId, 'role'=>'academic_admin', 'created_at'=>now(), 'updated_at'=>now()]);
      }
      foreach (['Shared', 'South'] as $name) {
        $id = (string) \Illuminate\Support\Str::uuid();
        \Illuminate\Support\Facades\DB::table('students')->insert(['id'=>$id, 'name'=>'Operations '.$name.' '.getenv('OPERATIONS_TEST_SUFFIX'),
          'name_search'=>'operations '.strtolower($name).' '.getenv('OPERATIONS_TEST_SUFFIX'),
          'request_id'=>(string) \Illuminate\Support\Str::uuid(), 'request_hash'=>str_repeat('0',64), 'created_by'=>$user->id, 'created_at'=>now(), 'updated_at'=>now()]);
        foreach ($name === 'Shared' ? $branches : [$branches[1]] as $branchId) {
          \Illuminate\Support\Facades\DB::table('student_branches')->insert(['student_id'=>$id, 'branch_id'=>$branchId, 'created_at'=>now()]);
        }
      }
    });
  `);
});
test.afterAll(() => {
  fixture(String.raw`
    if ($user) {
      $center->run(function () use ($user) {
        $ids = \Illuminate\Support\Facades\DB::table('branches')->where('slug', 'like', 'operations-'.getenv('OPERATIONS_TEST_SUFFIX').'-%')->pluck('id');
        $studentIds = \Illuminate\Support\Facades\DB::table('students')->where('created_by',$user->id)->pluck('id');
        \Illuminate\Support\Facades\DB::table('student_branches')->whereIn('student_id',$studentIds)->delete();
        \Illuminate\Support\Facades\DB::table('students')->whereIn('id',$studentIds)->delete();
        $instructorIds = \Illuminate\Support\Facades\DB::table('instructors')->where('created_by',$user->id)->pluck('id');
        \Illuminate\Support\Facades\DB::table('instructor_branches')->whereIn('instructor_id',$instructorIds)->delete();
        \Illuminate\Support\Facades\DB::table('instructors')->whereIn('id',$instructorIds)->delete();
        \Illuminate\Support\Facades\DB::table('curriculum_submissions')->where('created_by', $user->id)->delete();
        \Illuminate\Support\Facades\DB::table('center_audit_logs')->where('actor_id', $user->id)->delete();
        \Illuminate\Support\Facades\DB::table('courses')->whereIn('branch_id', $ids)->delete();
        \Illuminate\Support\Facades\DB::table('branch_grants')->where('user_id',$user->id)->delete();
        \Illuminate\Support\Facades\DB::table('center_grants')->where('user_id',$user->id)->delete();
        \Illuminate\Support\Facades\DB::table('branches')->whereIn('id',$ids)->delete();
      });
      \App\Models\CenterMembership::where('user_id',$user->id)->delete();
      $user->delete();
    }
  `);
});


test("current people sources, scoped creation, dirty switch, RTL themes and bounded SSR", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await choose(page, names[0]);
  await page.getByRole("link", { name: "الطلاب", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^(ملفات الطلاب|الطلاب)$/ })).toBeVisible();
  const northId = new URL(page.url()).searchParams.get("workspace");
  expect(northId).toMatch(/^[0-9a-f-]{36}$/i);
  const studentsUrl = origin + "/admin/students?workspace=" + northId + "&q=" + encodeURIComponent(suffix);
  const before = cursor();
  await page.goto(studentsUrl);
  await expect(page.getByRole("heading", { name: "Operations Shared " + suffix, exact: true })).toBeVisible();
  await expect.poll(() => reads(before).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const counts = reads(before);
  for (const count of counts) { expect(count).toMatch(/^\d+$/); expect(Number(count)).toBeLessThanOrEqual(6); }
  expect(counts.reduce((sum, count) => sum + Number(count), 0)).toBeLessThanOrEqual(6);
  console.log("147 authenticated student SSR SQL", counts);
  await expect(page.getByText("Operations South " + suffix, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "إجراءات الطالب Operations Shared " + suffix, exact: true }).click();
  await page.getByRole("menuitem", { name: "عرض الملف", exact: true }).click();
  const barcode = page.getByRole("link", { name: "طباعة الباركود الأساسي", exact: true });
  await expect(barcode).toHaveAttribute("href", new RegExp("workspace=" + northId));
  const northBarcode = new URL((await barcode.getAttribute("href"))!, origin).href;
  expect((await page.request.get(northBarcode)).ok()).toBe(true);
  await page.getByRole("link", { name: "المحاضرون", exact: true }).click();
  await page.getByRole("button", { name: "إنشاء ملف محاضر", exact: true }).click();
  await expect(page.locator("#instructor-branches")).toHaveCount(0);
  const instructorName = "Operations teacher " + suffix;
  await page.getByRole("textbox", { name: "اسم المحاضر", exact: true }).fill(instructorName);
  const saved = page.waitForResponse(response => response.url().endsWith("/api/v1/center/instructors") && response.request().method() === "POST");
  await page.getByRole("button", { name: "حفظ ملف المحاضر", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  expect((await response.json()).instructor.branch_ids).toHaveLength(1);
  await expect(page.getByText(instructorName, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "الطلاب", exact: true }).click();
  await page.getByRole("link", { name: "إنشاء ملف طالب", exact: true }).click();
  await expect(page.locator("#student-branches")).toHaveCount(0);
  await page.getByRole("textbox", { name: "اسم الطالب", exact: true }).fill("Operations draft " + suffix);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle("dark", value === "dark"); }, theme);
    for (const width of [2560, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole("button", { name: "حفظ ملف الطالب", exact: true })).toBeVisible();
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "تبديل مساحة العمل", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "اسم الطالب", exact: true })).toHaveValue("Operations draft " + suffix);
  await page.getByRole("link", { name: "تبديل مساحة العمل", exact: true }).click();
  await dialog.getByRole("button", { name: "مغادرة دون حفظ", exact: true }).click();
  await choose(page, names[1]);
  const southId = new URL(page.url()).searchParams.get("workspace");
  expect(southId).not.toBe(northId);
  await page.getByRole("link", { name: "المحاضرون", exact: true }).click();
  await expect(page.getByText(instructorName, { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "الطلاب", exact: true }).click();
  await page.getByRole("link", { name: "إنشاء ملف طالب", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "اسم الطالب", exact: true })).toHaveValue("");
});

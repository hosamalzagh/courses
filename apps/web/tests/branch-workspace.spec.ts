import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

const origin = "http://alpha.courses.test";
const apiDirectory = path.resolve(process.cwd(), "../api");
const php = process.env.COURSES_PHP_BIN ?? "php85";
const suffix = randomBytes(5).toString("hex");
const email = `workspace-${suffix}@courses.test`;
const password = randomBytes(18).toString("hex");
const names = [`فرع التحقق الشمالي ${suffix}`, `فرع التحقق الجنوبي ${suffix}`];
function fixture(code: string): string {
  return execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Only local browser fixtures');
    $center = \App\Models\Center::where('slug', 'alpha')->firstOrFail();
    $email = getenv('WORKSPACE_TEST_EMAIL');
    $user = \App\Models\User::where('email', $email)->first();
  ` + code], { cwd: apiDirectory, env: { ...process.env, WORKSPACE_TEST_EMAIL: email, WORKSPACE_TEST_PASSWORD: password, WORKSPACE_TEST_SUFFIX: suffix }, stdio: "pipe", encoding: "utf8" });
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
  await expect(page.getByRole("heading", { name: "اختيار مساحة العمل", exact: true })).toBeVisible();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator("[data-workspace-name]")).toHaveText(name);
}
function cursor() { return Number(fixture(String.raw`echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;`).trim()); }
function reads(since: number) {
  return JSON.parse(fixture(String.raw`
    echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'request')->where('sequence', '>', ` + since + String.raw`)
      ->whereRaw("content::jsonb->>'uri' LIKE '%api/v1/center/curriculum-explorer%'")
      ->whereRaw("content::jsonb->'headers'->>'host' = 'alpha.courses.test'")
      ->pluck('content')->map(fn ($content) => json_decode($content, true)['response_headers']['x-courses-query-count'] ?? null)->toJson();
  `)) as string[];
}

test.beforeAll(() => {
  fixture(String.raw`
    $user = \App\Models\User::factory()->create(['name'=>'Workspace Test', 'email'=>$email, 'email_verified_at'=>now(), 'password'=>getenv('WORKSPACE_TEST_PASSWORD')]);
    \App\Models\CenterMembership::create(['user_id'=>$user->id, 'tenant_id'=>$center->id, 'status'=>'active']);
    $center->run(function () use ($user) {
      foreach (['فرع التحقق الشمالي ', 'فرع التحقق الجنوبي '] as $index=>$name) {
        $id = \Illuminate\Support\Facades\DB::table('branches')->insertGetId(['name'=>$name.getenv('WORKSPACE_TEST_SUFFIX'), 'slug'=>'workspace-'.getenv('WORKSPACE_TEST_SUFFIX').'-'.$index, 'created_at'=>now(), 'updated_at'=>now()]);
        \Illuminate\Support\Facades\DB::table('branch_grants')->insert(['user_id'=>$user->id, 'branch_id'=>$id, 'role'=>'academic_admin', 'created_at'=>now(), 'updated_at'=>now()]);
      }
    });
  `);
});
test.afterAll(() => {
  fixture(String.raw`
    if ($user) {
      $center->run(function () use ($user) {
        $ids = \Illuminate\Support\Facades\DB::table('branches')->where('slug', 'like', 'workspace-'.getenv('WORKSPACE_TEST_SUFFIX').'-%')->pluck('id');
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

test("password, scoped course journey, independent tabs, dirty switch, Back and bounded SSR", async ({ page, context }) => {
  test.setTimeout(120_000);
  await login(page);
  await choose(page, names[0]);
  await page.getByRole("link", { name: "المناهج والخطط", exact: true }).click();
  await expect(page.getByRole("heading", { name: "منهج الفرع", exact: true })).toBeVisible();
  const northUrl = page.url();
  const firstId = new URL(northUrl).searchParams.get("workspace");
  await page.getByRole("button", { name: "إنشاء كورس", exact: true }).click();
  await expect(page.getByRole("group", { name: "الفرع الذي يملك الكورس" })).toHaveCount(0);
  const course = `كورس التحقق ${suffix}`;
  await page.getByRole("textbox", { name: "اسم الكورس" }).fill(course);
  await page.getByRole("button", { name: "حفظ المنهج", exact: true }).click();
  await page.getByRole("navigation", { name: "شجرة المنهج", exact: true }).getByRole("link", { name: course, exact: true }).click();
  await expect(page.getByRole("heading", { name: `مراحل ${course}`, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("workspace")).toBe(firstId);
  const second = await context.newPage();
  await second.goto(northUrl);
  await second.getByRole("link", { name: "تبديل مساحة العمل" }).click();
  await choose(second, names[1]);
  await expect(second.getByRole("link", { name: course, exact: true })).toHaveCount(0);
  const southId = new URL(second.url()).searchParams.get("workspace");
  await second.getByRole("link", { name: "الطلاب", exact: true }).click();
  await expect(second.getByRole("heading", { name: /^(ملفات الطلاب|الطلاب)$/, exact: true })).toBeVisible();
  await expect(second.locator(".route-progress")).toHaveCount(0);
  const search = second.getByRole("searchbox");
  await search.fill("workspace-no-result");
  await second.getByRole("search").locator("button[type=submit]").click();
  await expect.poll(() => new URL(second.url()).searchParams.get("q")).toBe("workspace-no-result");
  await expect.poll(() => new URL(second.url()).searchParams.get("workspace")).toBe(southId);
  await page.reload();
  await expect(page.locator("[data-workspace-name]")).toHaveText(names[0]);
  await page.getByRole("link", { name: "الكورسات", exact: true }).click();
  await expect(page.getByRole("heading", { name: "منهج الفرع", exact: true })).toBeVisible();
  await expect(page.locator(".route-progress")).toHaveCount(0);
  await page.getByRole("button", { name: "إنشاء كورس", exact: true }).click();
  await page.getByRole("textbox", { name: "اسم الكورس" }).fill("مسودة لا تنتقل للفرع الآخر");
  await page.getByRole("link", { name: "تبديل مساحة العمل" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "اسم الكورس" })).toHaveValue("مسودة لا تنتقل للفرع الآخر");
  expect(new URL(page.url()).searchParams.get("workspace")).toBe(firstId);
  await page.getByRole("link", { name: "تبديل مساحة العمل" }).click();
  await page.getByRole("button", { name: "مغادرة دون حفظ", exact: true }).click();
  await choose(page, names[1]);
  await expect(page.getByRole("textbox", { name: "اسم الكورس" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("course_id")).toBe(false);
  await page.goBack();
  await expect(page.locator("[data-workspace-name]")).toHaveText(names[0]);
  await page.goto(northUrl);
  for (const cold of [true, false]) {

    const since = cursor();
    await page.reload();
    await expect(page.getByRole("navigation", { name: "شجرة المنهج", exact: true }).getByRole("link", { name: course, exact: true })).toBeVisible();
    await expect.poll(() => reads(since).length).toBe(1);
    const counts = reads(since);
    expect(counts.every(count => /^\d+$/.test(count) && Number(count) <= 6 && Number(count) > 0)).toBe(true);
    console.log(`SSR curriculum ${cold ? 'cold' : 'warm'}: ${counts.join(',')} SQL, ${counts.length} request`);
  }
  // A delayed response from North must not redirect the newly selected South.
  let held: Route | undefined;
  let captured!: () => void;
  const ready = new Promise<void>(resolve => { captured = resolve; });
  await page.route("**/api/v1/center/courses", route => { held = route; captured(); });
  await page.getByRole("button", { name: "إنشاء كورس", exact: true }).click();
  await page.getByRole("textbox", { name: "اسم الكورس" }).fill("طلب قديم");
  await page.getByRole("button", { name: "حفظ المنهج", exact: true }).click();
  await ready;
  await page.getByRole("link", { name: "تبديل مساحة العمل" }).click();
  await page.getByRole("button", { name: "مغادرة دون حفظ", exact: true }).click();
  await choose(page, names[1]);
  const settledUrl = page.url();
  await held!.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "workspace_expired" }) });
  await page.waitForTimeout(250);
  expect(page.url()).toBe(settledUrl);
  await expect(page.locator("[data-workspace-name]")).toHaveText(names[1]);
  await second.close();
});

test("picker error, loading, RTL, keyboard and both themes at desktop and mobile widths", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.route("**/api/v1/center/workspaces", route => route.request().method() === "POST" ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "Forbidden" }) }) : route.continue());
  await page.getByRole("button", { name: names[0], exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "هذه العملية خارج صلاحيتك" })).toBeVisible();
  await page.unroute("**/api/v1/center/workspaces");
  for (const width of [2560, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle("dark", value === "dark"); }, theme);
      expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/workspace-picker-${width}-${theme}.png` });
    }
  }
  await page.getByRole("button", { name: names[0], exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-workspace-name]")).toHaveText(names[0]);
  await page.getByRole("button", { name: "القائمة", exact: true }).click();
  await page.getByRole("link", { name: "المناهج والخطط", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "منهج الفرع", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("MFA single branch auto-entry and zero branch recovery", async ({ page }) => {
  test.setTimeout(180_000);
  fixture(String.raw`
    $user->forceFill(['app_authentication_secret'=>app(\PragmaRX\Google2FA\Google2FA::class)->generateSecretKey()])->save();
    $center->run(function () use ($user) {
      $last = \Illuminate\Support\Facades\DB::table('branch_grants')->where('user_id',$user->id)->max('branch_id');
      \Illuminate\Support\Facades\DB::table('branch_grants')->where('user_id',$user->id)->where('branch_id',$last)->delete();
    });
  `);
  await login(page);
  await expect(page.getByRole("heading", { name: "تحقق من هويتك", exact: true })).toBeVisible();
  const code = fixture(String.raw`echo app(\PragmaRX\Google2FA\Google2FA::class)->getCurrentOtp($user->getAppAuthenticationSecret());`).trim();
  await page.getByRole("textbox", { name: "رمز التحقق" }).fill(code);
  await page.getByRole("button", { name: "تحقق وادخل", exact: true }).click();
  await expect(page.locator("[data-workspace-name]")).toHaveText(names[0]);
  await expect(page.getByRole("link", { name: "تبديل مساحة العمل" })).toHaveCount(0);
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page).toHaveURL(`${origin}/login`);
  fixture(String.raw`$user->forceFill(['app_authentication_secret'=>null])->save(); $center->run(fn()=>\Illuminate\Support\Facades\DB::table('branch_grants')->where('user_id',$user->id)->delete());`);
  await login(page);
  await expect(page.getByText("لا توجد فروع متاحة لك.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "إدارة المركز", exact: true })).toHaveCount(0);
});

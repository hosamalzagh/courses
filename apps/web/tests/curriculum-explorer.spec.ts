import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const origin = "http://alpha.courses.test";
const suffix = randomBytes(5).toString("hex");
const email = `explorer-${suffix}@courses.test`;
const password = randomBytes(18).toString("hex");
const branches = [`فرع الشجرة الشمالي ${suffix}`, `فرع الشجرة الجنوبي ${suffix}`];
const course = `كورس الشجرة ${suffix}`;
const stage = `مرحلة الشجرة ${suffix}`;
const level = `مستوى الشجرة ${suffix}`;
const group = `مجموعة الشجرة ${suffix}`;
const pagingCourse = `صفحة كورس 000 ${suffix}`;
const pagingStage = `صفحة مرحلة 000 ${suffix}`;
const teacher = `محاضر الشجرة ${suffix}`;
function fixture(code: string): string {
  try { return execFileSync(process.env.COURSES_PHP_BIN ?? "php85", ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Only local browser fixtures');
    $center = \App\Models\Center::where('slug','alpha')->firstOrFail();
    $user = \App\Models\User::where('email',getenv('EXPLORER_EMAIL'))->first();
  ` + code], { cwd: path.resolve(process.cwd(), "../api"), env: { ...process.env, EXPLORER_EMAIL: email, EXPLORER_PASSWORD: password, EXPLORER_SUFFIX: suffix }, encoding: "utf8", stdio: "pipe" }); } catch (error) { const failure = error as { stdout?: string; stderr?: string }; console.error(failure.stdout, failure.stderr); throw error; }
}
async function login(page: Page) {
  await page.goto(`${origin}/login`);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
    await page.getByRole("textbox", { name: "كلمة المرور" }).fill(password);
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/center/auth/login" && response.request().method() === "POST");
    await page.getByRole("button", { name: "دخول المركز" }).click();
    const response = await pending;
    if (response.status() === 429 && attempt < 2) {
      const retry = Number(response.headers()["retry-after"] ?? "60");
      expect(Number.isFinite(retry) && retry >= 0 && retry <= 60).toBe(true);
      const wait = (retry + 1) * 1000;
      test.setTimeout(test.info().timeout + wait);
      await page.waitForTimeout(wait);
      continue;
    }
    expect(response.status()).toBe(200);
    break;
  }
  await expect(page).toHaveURL(url => url.pathname === "/admin/workspaces", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "اختيار مساحة العمل", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: branches[0], exact: true }).click();
  await expect(page.getByRole("heading", { name: "الرئيسية", exact: true })).toBeVisible();
  await expect(page.locator(".route-progress")).toHaveCount(0);
  await page.getByRole("link", { name: "المناهج والخطط", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "شجرة المنهج", exact: true })).toBeVisible();
}
function tree(page: Page) { return page.getByRole("navigation", { name: "شجرة المنهج", exact: true }); }
async function select(page: Page, name: string) { const link = tree(page).getByRole("link", { name, exact: true }); await link.click(); await expect(link).toHaveAttribute("aria-current", "page"); await expect(page.locator(".route-progress")).toHaveCount(0); }
function cursor() { return Number(fixture(String.raw`echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;`).trim()); }
function reads(since: number) {
  return JSON.parse(fixture(String.raw`
    echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->where('type','request')->where('sequence','>', ` + since + String.raw`)
    ->whereRaw("content::jsonb->>'uri' LIKE '%api/v1/center/curriculum-explorer%'")
    ->whereRaw("content::jsonb->'headers'->>'host' = 'alpha.courses.test'")
    ->pluck('content')->map(fn ($value)=>json_decode($value,true)['response_headers']['x-courses-query-count'] ?? null)->toJson();
  `)) as (string | null)[];
}
test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  fixture(String.raw`
    $user = \App\Models\User::factory()->create(['email'=>getenv('EXPLORER_EMAIL'),'password'=>getenv('EXPLORER_PASSWORD'),'email_verified_at'=>now()]);
    \App\Models\CenterMembership::create(['user_id'=>$user->id,'tenant_id'=>$center->id,'status'=>'active']);
    $center->run(function () use ($user) {
      foreach (['فرع الشجرة الشمالي ','فرع الشجرة الجنوبي '] as $i=>$name) {
        $branch = \Illuminate\Support\Facades\DB::table('branches')->insertGetId(['name'=>$name.getenv('EXPLORER_SUFFIX'),'slug'=>'explorer-'.getenv('EXPLORER_SUFFIX').'-'.$i,'created_at'=>now(),'updated_at'=>now()]);
        \Illuminate\Support\Facades\DB::table('branch_grants')->insert(['user_id'=>$user->id,'branch_id'=>$branch,'role'=>'academic_admin','created_at'=>now(),'updated_at'=>now()]);
        if ($i===0) {
          for ($n=0; $n<55; $n++) {
            $course = (string) \Illuminate\Support\Str::uuid();
            \Illuminate\Support\Facades\DB::table('courses')->insert(['id'=>$course,'branch_id'=>$branch,'name'=>sprintf('صفحة كورس %03d ', $n).getenv('EXPLORER_SUFFIX'),'created_at'=>now()->addSeconds($n),'updated_at'=>now()]);
            if ($n===0) for ($m=0; $m<55; $m++) {
              \Illuminate\Support\Facades\DB::table('stages')->insert(['id'=>(string) \Illuminate\Support\Str::uuid(),'course_id'=>$course,'name'=>sprintf('صفحة مرحلة %03d ', $m).getenv('EXPLORER_SUFFIX'),'created_at'=>now()->addSeconds($m),'updated_at'=>now()]);
            }
          }
        }
        if ($i===0) {
          $teacher = (string) \Illuminate\Support\Str::uuid();
          \Illuminate\Support\Facades\DB::table('instructors')->insert(['id'=>$teacher,'name'=>'محاضر الشجرة '.getenv('EXPLORER_SUFFIX'),'name_search'=>'محاضر الشجرة '.getenv('EXPLORER_SUFFIX'),'created_by'=>$user->id,'request_id'=>(string) \Illuminate\Support\Str::uuid(),'request_hash'=>str_repeat('0',64),'created_at'=>now(),'updated_at'=>now()]);
          \Illuminate\Support\Facades\DB::table('instructor_branches')->insert(['instructor_id'=>$teacher,'branch_id'=>$branch,'created_at'=>now()]);
        }
      }
    });
  `);
});
test.afterAll(() => {
  fixture(String.raw`
    if ($user) {
      $center->run(function () use ($user) {
        \Illuminate\Support\Facades\DB::transaction(function () use ($user) {
          // Only this disposable fixture's records are deleted. Used plans have immutable triggers.
          \Illuminate\Support\Facades\DB::statement('ALTER TABLE plan_lectures DISABLE TRIGGER USER');
          \Illuminate\Support\Facades\DB::statement('ALTER TABLE study_plan_versions DISABLE TRIGGER USER');
          $branches = \Illuminate\Support\Facades\DB::table('branches')->where('slug','like','explorer-'.getenv('EXPLORER_SUFFIX').'-%')->pluck('id');
          $courses = \Illuminate\Support\Facades\DB::table('courses')->whereIn('branch_id',$branches)->pluck('id');
          $stages = \Illuminate\Support\Facades\DB::table('stages')->whereIn('course_id',$courses)->pluck('id');
          $levels = \Illuminate\Support\Facades\DB::table('levels')->whereIn('stage_id',$stages)->pluck('id');
          $plans = \Illuminate\Support\Facades\DB::table('study_plan_versions')->whereIn('level_id',$levels)->pluck('id');
          $groups = \Illuminate\Support\Facades\DB::table('study_groups')->whereIn('level_id',$levels)->pluck('id');
          foreach (['study_session_submissions','study_sessions','study_group_instructors','study_group_requirements'] as $table) \Illuminate\Support\Facades\DB::table($table)->whereIn('group_id',$groups)->delete();
          \Illuminate\Support\Facades\DB::table('study_groups')->whereIn('id',$groups)->delete();
          \Illuminate\Support\Facades\DB::table('plan_lectures')->whereIn('plan_version_id',$plans)->delete();
          \Illuminate\Support\Facades\DB::table('study_plan_versions')->whereIn('id',$plans)->delete();
          \Illuminate\Support\Facades\DB::table('levels')->whereIn('id',$levels)->delete();
          \Illuminate\Support\Facades\DB::table('stages')->whereIn('id',$stages)->delete();
          \Illuminate\Support\Facades\DB::table('courses')->whereIn('id',$courses)->delete();
          $teachers = \Illuminate\Support\Facades\DB::table('instructors')->where('created_by',$user->id)->pluck('id');
          \Illuminate\Support\Facades\DB::table('instructor_branches')->whereIn('instructor_id',$teachers)->delete();
          \Illuminate\Support\Facades\DB::table('instructors')->whereIn('id',$teachers)->delete();
          \Illuminate\Support\Facades\DB::table('curriculum_submissions')->where('created_by',$user->id)->delete();
          \Illuminate\Support\Facades\DB::table('center_audit_logs')->where('actor_id',$user->id)->delete();
          \Illuminate\Support\Facades\DB::table('branch_grants')->where('user_id',$user->id)->delete();
          \Illuminate\Support\Facades\DB::table('branches')->whereIn('id',$branches)->delete();
          \Illuminate\Support\Facades\DB::statement('ALTER TABLE plan_lectures ENABLE TRIGGER USER');
          \Illuminate\Support\Facades\DB::statement('ALTER TABLE study_plan_versions ENABLE TRIGGER USER');
        });
      });
      \App\Models\CenterMembership::where('user_id',$user->id)->delete(); $user->delete();
    }
  `);
});

test("tree disclosure, parent-fixed creation, plan editing, group sessions, refresh, Back and SQL", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  let documents = 0;
  page.on("request", request => { if (request.isNavigationRequest() && request.resourceType() === "document") documents++; });
  const shell = await page.locator(".center-sidebar").elementHandle();
  await page.getByRole("button", { name: "إنشاء كورس", exact: true }).click();
  await page.getByRole("textbox", { name: "اسم الكورس" }).fill(course);
  await page.getByRole("button", { name: "حفظ المنهج", exact: true }).click();
  await expect(page.getByRole("heading", { name: `مراحل ${course}`, exact: true })).toBeVisible();
  const courseId = new URL(page.url()).searchParams.get("id");
  await tree(page).getByRole("button", { name: `فتح أبناء ${course}`, exact: true }).click();
  await expect(tree(page).getByText("لا يوجد أبناء في هذه الدفعة.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "إضافة مرحلة دراسية", exact: true }).click();
  await page.getByRole("textbox", { name: "اسم المرحلة الدراسية" }).fill(stage);
  await page.getByRole("button", { name: "حفظ المنهج", exact: true }).click();
  await expect(page.getByRole("heading", { name: `مستويات ${stage}`, exact: true })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: stage, exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "إضافة مستوى وخطته", exact: true }).click();
  await page.getByRole("textbox", { name: "اسم المستوى", exact: true }).fill(level);
  await page.getByRole("textbox", { name: "محتوى المحاضرة 1", exact: true }).fill("المحاضرة المطلوبة للشجرة");
  await page.getByRole("button", { name: "حفظ المنهج", exact: true }).click();
  await expect(page.getByRole("heading", { name: `خطة ${level}`, exact: true })).toBeVisible();
  const levelId = new URL(page.url()).searchParams.get("id");
  await page.locator("[data-curriculum-details]").getByRole("button", { name: `إدارة المستوى: ${level}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "تعديل الخطة الأولى", exact: true }).click();
  await page.getByRole("textbox", { name: "محتوى المحاضرة 1", exact: true }).fill("تعديل محفوظ داخل الخطة");
  await page.getByRole("button", { name: "حفظ المنهج", exact: true }).click();
  await expect(page.getByText("تعديل محفوظ داخل الخطة", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "إنشاء مجموعة", exact: true }).click();
  await expect(page.getByRole("combobox", { name: `إصدار خطة ${level}` })).toBeVisible();
  await page.getByRole("textbox", { name: "اسم المجموعة", exact: true }).fill(group);
  await page.getByRole("checkbox", { name: teacher, exact: true }).check();
  await page.getByRole("button", { name: "حفظ المجموعة", exact: true }).click();
  await expect(page.getByRole("heading", { name: group, exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "طلاب المجموعة", exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "مواعيد المحاضرات", exact: false })).toBeVisible();
  expect(await shell!.evaluate(node => node.isConnected)).toBe(true);
  expect(documents).toBe(0);
  await page.getByRole("combobox", { name: "المحاضرة المعتمدة", exact: true }).selectOption("1");
  await page.getByRole("textbox", { name: "موعد المحاضرة بتوقيت القاهرة" }).fill("2027-01-20T15:00");
  await page.getByRole("button", { name: "معاينة المواعيد", exact: true }).click();
  await page.getByRole("button", { name: "تأكيد وحفظ ١ موعد", exact: true }).click();
  await expect(page.getByText("جُدولت جميع محاضرات المجموعة المعتمدة.", { exact: true })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: group, exact: true })).toHaveAttribute("aria-current", "page");
  await expect.poll(() => new URL(page.url()).searchParams.get("kind")).toBe("group");
  await expect(page.getByRole("heading", { name: "المحاضرات المطلوبة", exact: false })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "إصدارات خطة المستوى", exact: true })).not.toBeVisible();
  await page.setViewportSize({ width: 2560, height: 1050 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "/tmp/courses-148-tree-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "/tmp/courses-148-tree-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const selectedUrl = page.url();
  for (const label of ["cold", "warm"]) {
    const since = cursor();
    await page.reload();
    await expect(page.getByRole("heading", { name: group, exact: true }).first()).toBeVisible();
    await expect.poll(() => reads(since).length).toBe(1);
    const counts = reads(since); expect(counts.every(count => count && /^\d+$/.test(count) && Number(count) <= 6)).toBe(true);
    console.log(`Explorer ${label}: ${counts.join(',')} SQL / ${counts.length} SSR read`);
  }
  await select(page, course);
  await page.goBack();
  await expect(page).toHaveURL(selectedUrl);
  await expect(tree(page).getByRole("link", { name: group, exact: true })).toHaveAttribute("aria-current", "page");
  await select(page, level);
  await page.locator("[data-curriculum-details]").getByRole("button", { name: `إدارة المستوى: ${level}`, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "حذف المستوى", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  expect(courseId).toMatch(/^[0-9a-f-]{36}$/); expect(levelId).toMatch(/^[0-9a-f-]{36}$/);
});

// The next test starts at the collapsed root, so search must reach unloaded descendants.
test("server search, dirty navigation, mobile draft retention, loading retry and branch reset", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await expect(tree(page).getByRole("link", { name: group, exact: true })).toHaveCount(0);
  const search = page.getByRole("searchbox", { name: "بحث في المنهج", exact: true });
  await search.dispatchEvent("compositionstart");
  await search.fill("لا توجد نتيجة للشجرة");
  await page.waitForTimeout(350);
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  await search.dispatchEvent("compositionend");
  await expect(tree(page).getByText("لا توجد نتائج", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "مسح بحث المنهج", exact: true }).click();
  await expect(search).toBeFocused();
  await expect.poll(() => new URL(page.url()).searchParams.has("q")).toBe(false);
  // An older RSC search response must not overwrite newer text still being composed.
  let releaseSearch!: () => void;
  const heldSearch = new Promise<void>(resolve => { releaseSearch = resolve; });
  let sawSearch!: () => void;
  const interceptedSearch = new Promise<void>(resolve => { sawSearch = resolve; });
  await page.route("**/admin/curriculum?**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") === "abc" && route.request().headers()["rsc"] === "1") { sawSearch(); await heldSearch; }
    await route.continue();
  });
  await search.fill(" abc ");
  await interceptedSearch;
  await search.dispatchEvent("compositionstart");
  await search.fill("abc d");
  releaseSearch();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("abc");
  await expect(search).toHaveValue("abc d");
  await search.dispatchEvent("compositionend");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("abc d");
  await search.fill(group);
  await expect(tree(page).getByRole("link", { name: new RegExp(group) })).toBeVisible();
  await tree(page).getByRole("link", { name: new RegExp(group) }).click();
  await expect(page.getByRole("heading", { name: group, exact: true }).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  await select(page, course);
  await page.getByRole("button", { name: "إضافة مرحلة دراسية", exact: true }).click();
  await page.getByRole("textbox", { name: "اسم المرحلة الدراسية" }).fill("مسودة محفوظة عند الرجوع للشجرة");
  await tree(page).getByRole("link", { name: level, exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "اسم المرحلة الدراسية" })).toHaveValue("مسودة محفوظة عند الرجوع للشجرة");
  for (const width of [2560, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle("dark", value === "dark"); }, theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width < 901) {
        await page.getByRole("button", { name: "العودة للشجرة", exact: true }).click();
        await expect(tree(page)).toBeVisible();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        await page.getByRole("button", { name: `العودة إلى تفاصيل ${course}`, exact: true }).click();
        await expect(page.getByRole("textbox", { name: "اسم المرحلة الدراسية" })).toHaveValue("مسودة محفوظة عند الرجوع للشجرة");
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("link", { name: "تبديل مساحة العمل", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "مغادرة دون حفظ", exact: true }).click();
  await page.getByRole("button", { name: branches[1], exact: true }).click();
  await expect(page.getByRole("textbox", { name: "اسم المرحلة الدراسية" })).toHaveCount(0);
  await expect(tree(page).getByRole("link", { name: course, exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("id")).toBe(false);
  await page.getByRole("link", { name: "تبديل مساحة العمل", exact: true }).click();
  await page.getByRole("button", { name: branches[0], exact: true }).click();
  let failures = 0;
  await page.route("**/api/v1/center/curriculum-explorer/children?**", route => {
    if (++failures === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Retry" }) });
    return route.continue();
  });
  await tree(page).getByRole("button", { name: `فتح أبناء ${pagingCourse}`, exact: true }).click();
  await expect(tree(page).getByRole("button", { name: `إعادة تحميل أبناء ${pagingCourse}`, exact: true })).toBeVisible();
  await tree(page).getByRole("button", { name: `إعادة تحميل أبناء ${pagingCourse}`, exact: true }).click();
  await expect(tree(page).getByRole("link", { name: pagingStage, exact: true })).toBeVisible();
  await tree(page).getByRole("button", { name: `طي أبناء ${pagingCourse}`, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(tree(page).getByRole("link", { name: pagingStage, exact: true })).not.toBeVisible();
  const lateParent = `صفحة كورس 003 ${suffix}`;
  const lateParentId = new URL((await tree(page).getByRole("link", { name: lateParent, exact: true }).getAttribute("href"))!, origin).searchParams.get("id");
  let releaseChildren!: () => void;
  const heldChildren = new Promise<void>(resolve => { releaseChildren = resolve; });
  let sawChildren!: () => void;
  const interceptedChildren = new Promise<void>(resolve => { sawChildren = resolve; });
  let deliveredChildren!: () => void;
  const completedChildren = new Promise<void>(resolve => { deliveredChildren = resolve; });
  await page.route("**/api/v1/center/curriculum-explorer/children?**", async route => {
    if (new URL(route.request().url()).searchParams.get("id") !== lateParentId) return route.fallback();
    sawChildren(); await heldChildren;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Late owner error" }) }).catch(() => {});
    deliveredChildren();
  });
  await tree(page).getByRole("button", { name: `فتح أبناء ${lateParent}`, exact: true }).click();
  await interceptedChildren;
  await select(page, `صفحة كورس 001 ${suffix}`);
  releaseChildren(); await completedChildren;
  await expect(tree(page).getByRole("button", { name: `إعادة تحميل أبناء ${lateParent}`, exact: true })).toHaveCount(0);
  await expect(tree(page).getByText("Late owner error", { exact: true })).toHaveCount(0);
});


test("bounded root and child pages, expanded refresh without mount reads, keyboard and mobile root creation", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await tree(page).getByRole("link", { name: "الدفعة التالية", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("courses_page")).toBe("2");
  await expect(tree(page).getByRole("link", { name: `صفحة كورس 054 ${suffix}`, exact: true })).toBeVisible();
  await page.goBack();
  await expect(tree(page).getByRole("link", { name: pagingCourse, exact: true })).toBeVisible();
  await tree(page).getByRole("button", { name: `فتح أبناء ${pagingCourse}`, exact: true }).click();
  await expect(tree(page).getByRole("link", { name: pagingStage, exact: true })).toBeVisible();
  await tree(page).getByRole("button", { name: `المزيد من أبناء ${pagingCourse}`, exact: true }).click();
  await expect(tree(page).getByRole("link", { name: `صفحة مرحلة 054 ${suffix}`, exact: true })).toBeVisible();
  const since = cursor();
  let childReads = 0;
  page.on("request", request => { if (request.url().includes("/curriculum-explorer/children")) childReads++; });
  await page.reload();
  await expect(tree(page).getByRole("button", { name: `طي أبناء ${pagingCourse}`, exact: true })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: `صفحة مرحلة 054 ${suffix}`, exact: true })).toBeVisible();
  await expect.poll(() => reads(since).length).toBe(1);
  expect(childReads).toBe(0);
  expect(reads(since).every(count => count && /^\d+$/.test(count) && Number(count) <= 6)).toBe(true);
  await tree(page).getByRole("button", { name: `الدفعة السابقة من أبناء ${pagingCourse}`, exact: true }).click();
  await expect(tree(page).getByRole("link", { name: pagingStage, exact: true })).toBeVisible();
  await tree(page).getByRole("button", { name: `طي أبناء ${pagingCourse}`, exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(tree(page).getByRole("link", { name: pagingCourse, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: `مراحل ${pagingCourse}`, exact: true })).toBeVisible();
  // Detail batches belong to the selected parent and must clear on a different course.
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) await page.getByRole("button", { name: "الصفحة التالية في المراحل الدراسية", exact: true }).click();
  await page.getByRole("link", { name: "الصفحة التالية في المراحل الدراسية", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("stages_page")).toBe("2");
  await select(page, `صفحة كورس 001 ${suffix}`);
  await expect(page.getByRole("heading", { name: `مراحل صفحة كورس 001 ${suffix}`, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("stages_page")).toBe(false);
  // Disclosure updates the live URL without SSR; breadcrumbs must keep that newest state.
  await tree(page).getByRole("button", { name: `فتح أبناء صفحة كورس 002 ${suffix}`, exact: true }).click();
  await expect(tree(page).getByText("لا يوجد أبناء في هذه الدفعة.", { exact: true })).toBeVisible();
  const latestExpanded = new URL(page.url()).searchParams.get("expanded");
  await page.getByRole("link", { name: "الكورسات", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("expanded")).toBe(latestExpanded);
  await expect(page.getByRole("heading", { name: "منهج الفرع", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("expanded")).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "إنشاء كورس", exact: true }).click();
  await page.getByRole("textbox", { name: "اسم الكورس", exact: true }).fill("مسودة كورس الهاتف");
  await page.getByRole("button", { name: "العودة للشجرة", exact: true }).click();
  await page.getByRole("button", { name: "العودة إلى تفاصيل الكورس الجديد", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "اسم الكورس", exact: true })).toHaveValue("مسودة كورس الهاتف");
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  // The mobile document, rather than the desktop tree panel, remembers its scroll.
  await page.getByRole("button", { name: "العودة للشجرة", exact: true }).click();
  await tree(page).getByRole("link", { name: `صفحة كورس 030 ${suffix}`, exact: true }).scrollIntoViewIfNeeded();
  await tree(page).getByRole("link", { name: `صفحة كورس 030 ${suffix}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: `مراحل صفحة كورس 030 ${suffix}`, exact: true })).toBeVisible();
  const savedScroll = await page.evaluate(() => Number(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith("courses-curriculum-mobile-scroll:"))!)));
  expect(savedScroll).toBeGreaterThan(100);
  await page.reload();
  await page.getByRole("button", { name: "العودة للشجرة", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(savedScroll - 30);
  await expect(tree(page).getByRole("link", { name: `صفحة كورس 030 ${suffix}`, exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await select(page, `صفحة كورس 001 ${suffix}`);
  await page.getByRole("button", { name: "إضافة مرحلة دراسية", exact: true }).click();
  const emptyStage = `مرحلة فارغة للحذف ${suffix}`;
  await page.getByRole("textbox", { name: "اسم المرحلة الدراسية", exact: true }).fill(emptyStage);
  await page.getByRole("button", { name: "حفظ المنهج", exact: true }).click();
  await expect(page.getByRole("heading", { name: `مستويات ${emptyStage}`, exact: true })).toBeVisible();
  await select(page, `صفحة كورس 001 ${suffix}`);
  await tree(page).getByRole("button", { name: `فتح أبناء ${emptyStage}`, exact: true }).click();
  await expect(tree(page).getByRole("button", { name: `طي أبناء ${emptyStage}`, exact: true })).toBeVisible();
  const childMenu = page.locator("[data-curriculum-details]").getByRole("button", { name: `إدارة المرحلة الدراسية: ${emptyStage}`, exact: true });
  await childMenu.click();
  await page.getByRole("menuitem", { name: "حذف المرحلة الدراسية", exact: true }).click();
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(childMenu).toBeFocused();
  await childMenu.click();
  await page.getByRole("menuitem", { name: "حذف المرحلة الدراسية", exact: true }).click();
  const deleted = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().includes("/stages/"));
  await page.getByRole("button", { name: "حذف المرحلة الدراسية", exact: true }).click();
  expect((await deleted).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: `مراحل صفحة كورس 001 ${suffix}`, exact: true })).toBeVisible();
  const parentUrl = new URL(page.url());
  await expect.poll(async () => {
    const response = await page.request.get(`${origin}/api/v1/center/curriculum-explorer?kind=course&id=${parentUrl.searchParams.get("id")}`, { headers: { "X-Courses-Workspace": parentUrl.searchParams.get("workspace")!, Accept: "application/json" } });
    return (await response.json()).curriculum?.stages?.length;
  }).toBe(0);
  await expect(page.getByRole("heading", { name: "لا توجد مراحل دراسية. أضف مرحلة لهذا الكورس من الهيدر.", exact: true })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: emptyStage, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "إضافة مرحلة دراسية", exact: true })).toBeVisible();
  const emptyCourseId = fixture(String.raw`$center->run(function () { echo \Illuminate\Support\Facades\DB::table('courses')->where('name', 'صفحة كورس 054 '.getenv('EXPLORER_SUFFIX'))->value('id'); });`).trim();
  const workspace = new URL(page.url()).searchParams.get("workspace")!;
  await page.goto(`${origin}/admin/curriculum?tab=stages&course_id=${emptyCourseId}&workspace=${workspace}`);
  await expect(page.getByRole("heading", { name: `مراحل صفحة كورس 054 ${suffix}`, exact: true })).toBeVisible();
  await page.locator("[data-curriculum-details]").getByRole("button", { name: `إدارة الكورس: صفحة كورس 054 ${suffix}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "حذف الكورس", exact: true }).click();
  await page.getByRole("button", { name: "حذف الكورس", exact: true }).click();
  await expect(page.getByRole("heading", { name: "منهج الفرع", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("course_id")).toBe(false);
});

test("read-only source exposes copy when a different branch grants curriculum management", async ({ page }) => {
  fixture(String.raw`$center->run(function () use ($user) { $north = \Illuminate\Support\Facades\DB::table('branches')->where('slug','explorer-'.getenv('EXPLORER_SUFFIX').'-0')->value('id'); \Illuminate\Support\Facades\DB::table('branch_grants')->where('user_id',$user->id)->where('branch_id',$north)->update(['role'=>'branch_viewer']); });`);
  await login(page);
  await expect(page.getByRole("button", { name: "إنشاء كورس", exact: true })).toHaveCount(0);
  await tree(page).getByRole("button", { name: `إدارة الكورس: ${pagingCourse}`, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "نسخ المنهج إلى فرع", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "إضافة مرحلة دراسية", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "نسخ المنهج إلى فرع", exact: true }).click();
  await expect(page.getByLabel("الفرع الوجهة").getByRole("option", { name: branches[1], exact: true })).toBeAttached();
});

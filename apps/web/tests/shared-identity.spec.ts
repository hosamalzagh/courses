import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { credentials, ensureLocalFixtures, invitationUrl, signIn } from "./local-fixtures";
import { apiDirectory, php } from "./platform-fixtures";

const alpha = "http://alpha.courses.test";
const beta = "http://beta.courses.test";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await ensureLocalFixtures(browser);
});

async function invite(page: Page, host: string, email: string) {
  await page.goto(`${host}/admin/members`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
  await page.getByRole("button", { name: "إرسال الدعوة" }).click();
  await expect(page.getByRole("status")).toContainText("أُرسلت الدعوة");
}

async function accept(page: Page, host: string, email: string, password: string) {
  await page.goto(await invitationUrl(email, new URL(host).hostname));
  await expect(page.getByRole("heading", { name: "ابدأ عضويتك" })).toBeVisible();
  await page.getByRole("textbox", { name: "الاسم" }).fill("Shared Browser Member");
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(password);
  await page.getByRole("textbox", { name: "تأكيد كلمة المرور" }).fill(password);
  await page.getByRole("button", { name: "قبول الدعوة" }).click();
  await expect(page).toHaveURL(/\/login\?invitation=accepted/);
}

async function grant(page: Page, host: string, email: string, branch: string, role: string) {
  await page.goto(`${host}/admin/members`);
  const card = page.getByRole("article").filter({ hasText: email });
  await card.getByRole("button", { name: "تعديل الأدوار" }).click();
  await card.getByRole("group", { name: branch }).getByRole("checkbox", { name: role }).check();
  await card.getByRole("button", { name: "حفظ الأدوار" }).click();
  await expect(card).toContainText("نشط");
}

function cleanSharedFixture(email: string) {
  execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (config('database.connections.central.database') !== 'courses_central') {
      throw new \RuntimeException('Local browser cleanup requires courses_central');
    }
    $email = getenv('COURSES_TEST_EMAIL');
    $user = \App\Models\User::where('email', $email)->first();
    $auditQuery = \Illuminate\Support\Facades\DB::connection('central')->table('center_audit_outbox');
    if ($user) $auditQuery->where('actor_id', $user->id)->orWhereRaw("details->>'email' = ?", [$email]);
    else $auditQuery->whereRaw("details->>'email' = ?", [$email]);
    $audit = $auditQuery->pluck('id')->all();
    foreach (['alpha', 'beta'] as $slug) {
      $center = \App\Models\Center::where('slug', $slug)->first();
      if (!$center) continue;
      $center->run(function () use ($user, $audit) {
        if ($user) {
          \Illuminate\Support\Facades\DB::table('branch_grants')->where('user_id', $user->id)->delete();
          \Illuminate\Support\Facades\DB::table('center_grants')->where('user_id', $user->id)->delete();
          \Illuminate\Support\Facades\DB::table('center_audit_logs')->where('actor_id', $user->id)->delete();
          \Illuminate\Support\Facades\DB::table('center_audit_logs')
            ->whereRaw("details->>'user_id' = ?", [(string) $user->id])->delete();
        }
        \Illuminate\Support\Facades\DB::table('center_audit_logs')->whereIn('source_event_id', $audit)->delete();
      });
    }
    \Illuminate\Support\Facades\DB::connection('central')->table('center_audit_outbox')->whereIn('id', $audit)->delete();
    \App\Models\CenterInvitation::where('email', $email)->delete();
    if ($user) {
      \App\Models\CenterMembership::where('user_id', $user->id)->delete();
      $user->delete();
    }
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_EMAIL: email }, stdio: "pipe" });
}

function telescopeSequence() {
  const result = execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;
  `], { cwd: apiDirectory, stdio: "pipe" }).toString().trim();
  return Number(result);
}

function pageRequestCounts(afterSequence: number, host: string): number[] {
  const result = execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    $rows = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TEST_SEQUENCE'))
      ->whereRaw("content::jsonb->'headers'->>'host' = ?", [getenv('COURSES_TEST_HOST')])
      ->orderBy('sequence')->pluck('content');
    echo json_encode($rows->map(function ($content) {
      $data = json_decode($content, true);
      return isset($data['response_headers']['x-courses-query-count'])
        ? (int) $data['response_headers']['x-courses-query-count'] : -1;
    })->all());
  `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_SEQUENCE: String(afterSequence), COURSES_TEST_HOST: host }, stdio: "pipe" }).toString().trim();
  return JSON.parse(result) as number[];
}

async function expectRenderedPageWithinBudget(page: Page, host: string) {
  const cursor = telescopeSequence();
  await page.reload();
  await expect.poll(() => pageRequestCounts(cursor, host).length, { timeout: 10_000 }).toBeGreaterThan(0);
  const counts = pageRequestCounts(cursor, host);
  expect(counts.every((count) => count > 0)).toBe(true);
  expect(counts.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(6);
}

test("one central identity has separate alpha and beta grants, pages, and host sessions", async ({ browser }) => {
  test.setTimeout(180_000);
  const email = `shared-browser-${Date.now()}@courses.test`;
  const password = randomBytes(24).toString("base64url");
  const alphaOwner = credentials("alpha");
  const betaOwner = credentials("beta");
  const alphaOwnerPage = await browser.newPage();
  const betaOwnerPage = await browser.newPage();
  const invitationPage = await browser.newPage();
  const alphaPage = await browser.newPage();
  const betaPage = await browser.newPage();
  let copiedContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await signIn(alphaOwnerPage, alpha, alphaOwner.email, alphaOwner.password);
    await invite(alphaOwnerPage, alpha, email);
    await accept(invitationPage, alpha, email, password);
    await grant(alphaOwnerPage, alpha, email, "الفرع الشمالي", "عرض الفرع");

    await signIn(betaOwnerPage, beta, betaOwner.email, betaOwner.password);
    await invite(betaOwnerPage, beta, email);
    await accept(invitationPage, beta, email, password);
    await grant(betaOwnerPage, beta, email, "beta-stable", "مدير الفرع");

    await signIn(alphaPage, alpha, email, password);
    await expect(alphaPage.getByRole("heading", { name: "الفرع الشمالي" })).toBeVisible();
    await expect(alphaPage.getByText("beta-stable")).toHaveCount(0);
    await expect(alphaPage.getByText("صلاحية عرض فقط")).toBeVisible();
    expect((await alphaPage.request.get(`${alpha}/api/v1/center/user?tenant_id=beta&database=beta`)).status()).toBe(400);
    const alphaResponse = await alphaPage.request.get(`${alpha}/api/v1/center/user`);
    expect(alphaResponse.status()).toBe(200);
    const alphaData = await alphaResponse.json();
    expect(alphaData.center.slug).toBe("alpha");
    expect(Object.values(alphaData.user.permissions.branch_roles).flat()).toContain("branch_viewer");
    expect(Number(alphaResponse.headers()["x-courses-query-count"])).toBeGreaterThan(0);
    expect(Number(alphaResponse.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);

    copiedContext = await browser.newContext();
    const copiedCookies = (await alphaPage.context().cookies(alpha)).map((cookie) => ({ ...cookie, domain: "beta.courses.test" }));
    await copiedContext.addCookies(copiedCookies);
    const copiedPage = await copiedContext.newPage();
    expect((await copiedPage.request.get(`${beta}/api/v1/center/user`)).status()).toBe(401);
    await copiedPage.goto(`${beta}/admin`);
    await expect(copiedPage).toHaveURL(`${beta}/login?expired=1`);

    await signIn(betaPage, beta, email, password);
    await expect(betaPage.getByRole("heading", { name: "beta-stable" })).toBeVisible();
    await expect(betaPage.getByText("الفرع الشمالي")).toHaveCount(0);
    await expect(betaPage.getByRole("button", { name: "تعديل بيانات الفرع" })).toBeVisible();
    const betaResponse = await betaPage.request.get(`${beta}/api/v1/center/user`);
    expect(betaResponse.status()).toBe(200);
    const betaData = await betaResponse.json();
    expect(betaData.user.id).toBe(alphaData.user.id);
    expect(betaData.center.slug).toBe("beta");
    expect(Object.values(betaData.user.permissions.branch_roles).flat()).toContain("branch_manager");
    expect(Number(betaResponse.headers()["x-courses-query-count"])).toBeGreaterThan(0);
    expect(Number(betaResponse.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    await expectRenderedPageWithinBudget(alphaPage, "alpha.courses.test");
    await expectRenderedPageWithinBudget(betaPage, "beta.courses.test");
    await expect(alphaPage.getByRole("heading", { name: "الفرع الشمالي" })).toBeVisible();
    await expect(betaPage.getByRole("heading", { name: "beta-stable" })).toBeVisible();
  } finally {
    await Promise.all([alphaOwnerPage.close(), betaOwnerPage.close(), invitationPage.close(), alphaPage.close(), betaPage.close(), copiedContext?.close()]);
    cleanSharedFixture(email);
  }
});

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const platform = "http://courses.test";
const apiDirectory = path.resolve(process.cwd(), "../api");
const php = process.env.COURSES_PHP_BIN ?? (process.platform === "darwin" ? "php85" : "php");

function platformOwnerCredentials() {
  const text = readFileSync(path.join(apiDirectory, "storage/app/private/local-platform-credentials.txt"), "utf8");
  const value = (key: string) => text.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1];
  const email = value("Email");
  const password = value("Password");
  if (!email || !password) throw new Error("Missing local platform owner credentials. Run courses:bootstrap-local.");
  return { email, password };
}

function currentPlatformCode(email: string) {
  return execFileSync(php, [
    "artisan", "tinker", "--execute",
    String.raw`$user = \App\Models\User::where('email', getenv('COURSES_TEST_EMAIL'))->firstOrFail(); echo \Filament\Auth\MultiFactor\App\AppAuthentication::make()->getCurrentCode($user);`,
    "--no-interaction",
  ], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_EMAIL: email } }).toString().trim();
}

async function signInToPlatform(page: Page, email: string, password: string) {
  await page.goto(`${platform}/admin/login`);
  await page.locator("#form\\.email").fill(email);
  await page.locator("#form\\.password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const firstCode = currentPlatformCode(email);
  await page.locator("#multiFactorChallengeForm\\.app\\.code").fill(firstCode);
  await page.getByRole("button", { name: "Confirm sign in" }).click();
  await page.waitForTimeout(500);
  if (await page.getByText("The code you entered is invalid.").isVisible()) {
    const start = Date.now();
    let freshCode = firstCode;
    while (freshCode === firstCode && Date.now() - start < 35_000) {
      await page.waitForTimeout(1_000);
      freshCode = currentPlatformCode(email);
    }
    if (freshCode === firstCode) throw new Error("A new authenticator code did not become available.");
    await page.locator("#multiFactorChallengeForm\\.app\\.code").fill(freshCode);
    await page.getByRole("button", { name: "Confirm sign in" }).click();
  }
  await expect(page).toHaveURL(`${platform}/admin`);
}

test("platform support sees central status but cannot manage platform or enter a center", async ({ browser }) => {
  test.setTimeout(90_000);
  const owner = platformOwnerCredentials();
  const ownerPage = await browser.newPage();
  const supportPage = await browser.newPage();
  const supportEmail = `browser-support-${Date.now()}@courses.test`;
  const supportPassword = randomBytes(24).toString("base64url");
  try {
    await signInToPlatform(ownerPage, owner.email, owner.password);
    await ownerPage.goto(`${platform}/admin/users/create`);
    await ownerPage.locator("#form\\.name").fill("Browser Support");
    await ownerPage.locator("#form\\.email").fill(supportEmail);
    await ownerPage.locator("#form\\.platform_role").selectOption("platform_support");
    await ownerPage.locator("#form\\.password").fill(supportPassword);
    await ownerPage.getByRole("button", { name: "Create", exact: true }).click();
    await expect(ownerPage).toHaveURL(/\/admin\/users\/\d+\/edit$/);

    await supportPage.goto(`${platform}/admin/login`);
    await supportPage.locator("#form\\.email").fill(supportEmail);
    await supportPage.locator("#form\\.password").fill(supportPassword);
    await supportPage.getByRole("button", { name: "Sign in" }).click();
    await expect(supportPage).toHaveURL(/multi-factor-authentication\/set-up/);
    await supportPage.getByRole("button", { name: "Set up" }).click();
    await expect(supportPage.getByRole("dialog")).toBeAttached();
    await expect(supportPage.locator("#mountedActionSchema0\\.code")).toBeAttached();
    const secret = (await supportPage.locator("[role=dialog] [role=button]").allTextContents())
      .map((value) => value.trim()).find((value) => /^[A-Z2-7]{16,}$/.test(value));
    if (!secret) throw new Error("The authenticator setup secret is missing.");
    const setupCode = execFileSync(php, ["-r", String.raw`require 'vendor/autoload.php'; echo (new \PragmaRX\Google2FA\Google2FA)->getCurrentOtp(getenv('COURSES_TEST_SECRET'));`],
      { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_SECRET: secret } }).toString().trim();
    await supportPage.locator("#mountedActionSchema0\\.code").fill(setupCode);
    await supportPage.locator("#mountedActionSchema0\\.password").fill(supportPassword);
    await supportPage.getByRole("button", { name: "Next" }).click();
    await supportPage.getByRole("button", { name: "Enable authenticator app" }).click();
    await supportPage.getByRole("button", { name: "Continue" }).click();
    await expect(supportPage).toHaveURL(`${platform}/admin`);
    await expect(supportPage.getByRole("link", { name: "المراكز" })).toBeVisible();
    await expect(supportPage.getByRole("link", { name: "موظفو المنصة" })).toHaveCount(0);
    await expect(supportPage.getByRole("link", { name: "سجل المنصة" })).toHaveCount(0);

    const centers = await supportPage.request.get(`${platform}/admin/centers`);
    expect(centers.status()).toBe(200);
    const queryCount = Number(centers.headers()["x-courses-query-count"]);
    expect(queryCount).toBeGreaterThan(0);
    expect(queryCount).toBeLessThanOrEqual(6);
    await supportPage.goto(`${platform}/admin/centers`);
    const centerPath = await supportPage.locator('a[href*="/admin/centers/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? "")
        .find((href) => /\/admin\/centers\/(?!create(?:\/|$))[^/]+/.test(href)));
    if (!centerPath) throw new Error("The local demo center is missing. Run courses:bootstrap-local.");
    const centerId = centerPath.match(/\/admin\/centers\/([^/]+)/)?.[1];
    if (!centerId) throw new Error("The center status link is invalid.");
    const status = await supportPage.request.get(`${platform}/admin/centers/${centerId}`);
    expect(status.status()).toBe(200);
    expect(Number(status.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    for (const route of ["users", "platform-audit-logs", "centers/create"]) {
      expect((await supportPage.request.get(`${platform}/admin/${route}`)).status()).toBe(403);
    }
    expect((await supportPage.request.get(`${platform}/admin/centers/${centerId}/edit`)).status()).toBe(403);
    expect((await supportPage.request.get("http://alpha.courses.test/api/v1/center/user")).status()).toBe(401);
  } finally {
    await ownerPage.close();
    await supportPage.close();
    execFileSync(php, [
      "artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
        $user = \App\Models\User::where('email', getenv('COURSES_TEST_EMAIL'))
          ->where('platform_role', 'platform_support')->first();
        if ($user) {
          \Illuminate\Support\Facades\DB::connection('central')->transaction(function () use ($user) {
            \Illuminate\Support\Facades\DB::connection('central')->table('platform_audit_logs')
              ->whereRaw("details->>'user_id' = ?", [(string) $user->id])->delete();
            $user->delete();
          });
        }
      `,
    ], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_EMAIL: supportEmail }, stdio: "pipe" });
  }
});

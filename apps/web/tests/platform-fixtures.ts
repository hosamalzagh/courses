import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const platform = "http://courses.test";
export const apiDirectory = path.resolve(process.cwd(), "../api");
export const php = process.env.COURSES_PHP_BIN ?? (process.platform === "darwin" ? "php85" : "php");

export function platformOwnerCredentials() {
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

export async function enrollPlatformMfa(page: Page, password: string) {
  await expect(page).toHaveURL(/multi-factor-authentication\/set-up/);
  await page.getByRole("button", { name: "Set up" }).click();
  await expect(page.locator("#mountedActionSchema0\\.code")).toBeAttached();
  const secret = (await page.locator("[role=dialog] [role=button]").allTextContents())
    .map((value) => value.trim()).find((value) => /^[A-Z2-7]{16,}$/.test(value));
  if (!secret) throw new Error("The authenticator setup secret is missing.");
  const code = execFileSync(php, ["-r", String.raw`require 'vendor/autoload.php'; echo (new \PragmaRX\Google2FA\Google2FA)->getCurrentOtp(getenv('COURSES_TEST_SECRET'));`],
    { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_SECRET: secret } }).toString().trim();
  await page.locator("#mountedActionSchema0\\.code").fill(code);
  await page.locator("#mountedActionSchema0\\.password").fill(password);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Enable authenticator app" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(`${platform}/admin`);
}

export async function signInToPlatform(page: Page, email: string, password: string) {
  await page.goto(`${platform}/admin/login`);
  await page.locator("#form\\.email").fill(email);
  await page.locator("#form\\.password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.poll(async () => page.url().includes("multi-factor-authentication/set-up")
    || await page.locator("#multiFactorChallengeForm\\.app\\.code").isVisible()).toBe(true);
  if (page.url().includes("multi-factor-authentication/set-up")) {
    await enrollPlatformMfa(page, password);
    return;
  }
  let previousCode = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let code = currentPlatformCode(email);
    const started = Date.now();
    while (code === previousCode && Date.now() - started < 35_000) {
      await page.waitForTimeout(1_000);
      code = currentPlatformCode(email);
    }
    if (code === previousCode) throw new Error("A new authenticator code did not become available.");
    previousCode = code;
    await page.locator("#multiFactorChallengeForm\\.app\\.code").fill(code);
    await page.getByRole("button", { name: "Confirm sign in" }).click();
    try {
      await expect(page).toHaveURL(`${platform}/admin`, { timeout: 2_000 });
      return;
    } catch {
      const alert = await page.getByRole("alert").allTextContents();
      const retrySeconds = alert.join(" ").match(/Please try again in (\d+) seconds/i)?.[1];
      if (retrySeconds) {
        await page.waitForTimeout((Number(retrySeconds) + 1) * 1_000);
      } else if (!await page.getByText("The code you entered is invalid.").isVisible()) {
        throw new Error(`Platform sign in failed: ${alert.join(" ").trim() || "unknown response"}`);
      }
    }
  }
  throw new Error("Platform sign in failed after three authenticator attempts.");
}

export function platformAuditCount(centerId: string, event: string) {
  const value = execFileSync(php, [
    "artisan", "tinker", "--execute",
    String.raw`echo \Illuminate\Support\Facades\DB::connection('central')->table('platform_audit_logs')->where('tenant_id', getenv('COURSES_TEST_CENTER_ID'))->where('event', getenv('COURSES_TEST_EVENT'))->count();`,
    "--no-interaction",
  ], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_CENTER_ID: centerId, COURSES_TEST_EVENT: event } }).toString().trim();
  return Number(value);
}

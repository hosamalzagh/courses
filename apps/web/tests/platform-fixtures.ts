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

export async function signInToPlatform(page: Page, email: string, password: string) {
  await page.goto(`${platform}/admin/login`);
  await page.locator("#form\\.email").fill(email);
  await page.locator("#form\\.password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
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

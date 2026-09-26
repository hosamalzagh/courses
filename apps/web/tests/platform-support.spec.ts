import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { apiDirectory, php, platform, platformOwnerCredentials, signInToPlatform } from "./platform-fixtures";

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

    await signInToPlatform(supportPage, supportEmail, supportPassword);
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

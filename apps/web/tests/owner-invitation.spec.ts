import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

const apiDirectory = path.resolve(process.cwd(), "../api");
const php = process.env.COURSES_PHP_BIN ?? (process.platform === "darwin" ? "php85" : "php");

function runFixture(code: string, slug: string, email: string) {
  try {
    execFileSync(php, ["artisan", "tinker", "--no-interaction", `--execute=${code}`], {
      cwd: apiDirectory,
      env: { ...process.env, COURSES_BROWSER_SLUG: slug, COURSES_BROWSER_EMAIL: email },
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch (error) {
    const failure = error as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(String(failure.stderr?.length ? failure.stderr : failure.stdout ?? error));
  }
}

test("first owner follows the Mailpit invitation on the center host and accepts once", async ({ page }) => {
  test.setTimeout(120_000);
  const slug = `inv-${randomBytes(6).toString("hex")}`;
  const email = `${slug}@courses.test`;
  const host = `http://${slug}.courses.test`;
  const password = randomBytes(24).toString("base64url");

  try {
    runFixture(String.raw`
      $slug = getenv('COURSES_BROWSER_SLUG');
      $email = getenv('COURSES_BROWSER_EMAIL');
      $center = \App\Models\Center::create(['name' => 'Invitation Browser Center', 'slug' => $slug, 'plan' => 'starter', 'owner_email' => $email]);
      $center->domains()->create(['domain' => $slug.'.courses.test']);
      \App\Jobs\ProvisionCenter::dispatchSync($center->id);
      if ($center->fresh()->provisioning_status !== 'active') {
        throw new \RuntimeException('Browser center provisioning failed');
      }
      $center->update(['provisioning_status' => 'failed']);
      \App\Jobs\ProvisionCenter::dispatchSync($center->id);
      if ($center->fresh()->provisioning_status !== 'active') {
        throw new \RuntimeException('Browser center retry failed');
      }
    `, slug, email);

    let invitation = "";
    let messageCount = 0;
    await expect.poll(async () => {
      const inbox = await (await fetch("http://127.0.0.1:8025/api/v1/messages")).json();
      messageCount = 0;
      for (const message of inbox.messages as { ID: string; To: { Address: string }[] }[]) {
        if (!message.To.some((recipient) => recipient.Address === email)) continue;
        messageCount++;
        const detail = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)).json();
        invitation ||= String(detail.Text ?? "").match(new RegExp(`http:\\/\\/${slug}\\.courses\\.test\\/invitations\\/[^\\s<>"']+`))?.[0] ?? "";
      }
      return Boolean(invitation);
    }, { timeout: 10_000 }).toBe(true);
    expect(messageCount).toBe(1);

    const invitationRequest = page.waitForResponse((response) => response.url().includes("/api/v1/center/invitations/") && response.request().method() === "GET");
    await page.goto(invitation);
    const invitationResponse = await invitationRequest;
    expect(invitationResponse.ok()).toBe(true);
    expect(Number(invitationResponse.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    await expect(page.getByRole("heading", { name: "ابدأ عضويتك" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await page.getByRole("textbox", { name: "الاسم" }).fill("Browser Owner");
    await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(password);
    await page.getByRole("textbox", { name: "تأكيد كلمة المرور" }).fill(password);
    await page.getByRole("button", { name: "قبول الدعوة" }).click();
    await expect(page).toHaveURL(`${host}/login?invitation=accepted`);

    await page.goto(invitation);
    await expect(page.getByRole("heading", { name: "ابدأ عضويتك" })).toBeVisible();
    await expect(page.getByRole("button", { name: "قبول الدعوة" })).toHaveCount(0);
  } finally {
    runFixture(String.raw`
      $slug = getenv('COURSES_BROWSER_SLUG');
      $email = getenv('COURSES_BROWSER_EMAIL');
      $center = \App\Models\Center::where('slug', $slug)->first();
      if ($center) {
        \Illuminate\Support\Facades\DB::connection('central')->table('center_audit_outbox')->where('tenant_id', $center->id)->delete();
        \Illuminate\Support\Facades\DB::connection('central')->table('platform_audit_logs')->where('tenant_id', $center->id)->delete();
        \App\Models\CenterMembership::where('tenant_id', $center->id)->delete();
        \App\Models\CenterInvitation::where('tenant_id', $center->id)->delete();
        $center->domains()->delete();
        $database = $center->database()->getName();
        if (!preg_match('/^courses_center_[a-f0-9-]{36}$/', $database)) {
          throw new \RuntimeException('Unexpected browser center database name');
        }
        \Illuminate\Support\Facades\DB::connection('provisioning')->statement('DROP DATABASE IF EXISTS "'.$database.'" WITH (FORCE)');
        \Illuminate\Support\Facades\DB::connection('central')->table('tenants')->where('id', $center->id)->delete();
        \App\Models\User::where('email', $email)->delete();
      }
    `, slug, email);
  }
});

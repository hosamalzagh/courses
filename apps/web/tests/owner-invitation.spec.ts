import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

const apiDirectory = path.resolve(process.cwd(), "../api");
const php = process.env.COURSES_PHP_BIN ?? (process.platform === "darwin" ? "php85" : "php");

function runFixture(code: string, slug: string, email: string, variables: Record<string, string> = {}): string {
  try {
    return execFileSync(php, ["artisan", "tinker", "--no-interaction", `--execute=${code}`], {
      cwd: apiDirectory,
      env: { ...process.env, COURSES_BROWSER_SLUG: slug, COURSES_BROWSER_EMAIL: email, ...variables },
      stdio: "pipe",
      timeout: 30_000,
      encoding: "utf8",
    });
  } catch (error) {
    const failure = error as { stderr?: Buffer | string; stdout?: Buffer | string };
    throw new Error(String(failure.stderr?.length ? failure.stderr : failure.stdout ?? error));
  }
}

function oneTimeCode(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of secret.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("first owner accepts, signs in with MFA, sees current roles, and signs out on the center host", async ({ page }) => {
  test.setTimeout(180_000);
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

    await page.goto(`${host}/login`);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
    await page.getByRole("textbox", { name: "كلمة المرور" }).fill(password);
    await page.getByRole("button", { name: "دخول المركز" }).click();
    await expect(page).toHaveURL(`${host}/admin`);
    await expect(page.getByText("مالك المركز")).toBeVisible();
    runFixture(String.raw`
      $center = \App\Models\Center::where('slug', getenv('COURSES_BROWSER_SLUG'))->firstOrFail();
      $user = \App\Models\User::where('email', getenv('COURSES_BROWSER_EMAIL'))->firstOrFail();
      $center->run(fn () => \Illuminate\Support\Facades\DB::table('center_grants')->where('user_id', $user->id)->where('role', 'center_owner')->delete());
    `, slug, email);
    await page.getByRole("button", { name: "إنشاء فرع" }).click();
    await page.getByRole("textbox", { name: "اسم الفرع" }).fill("Denied Browser Branch");
    await page.getByRole("textbox", { name: "رمز الفرع" }).fill("denied-browser-branch");
    const forbiddenResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/center/branches") && response.request().method() === "POST");
    await page.getByRole("button", { name: "حفظ الفرع" }).click();
    expect((await forbiddenResponse).status()).toBe(403);
    await expect(page.locator(".notice[role=alert]")).toContainText("خارج صلاحيتك");
    runFixture(String.raw`
      $center = \App\Models\Center::where('slug', getenv('COURSES_BROWSER_SLUG'))->firstOrFail();
      $user = \App\Models\User::where('email', getenv('COURSES_BROWSER_EMAIL'))->firstOrFail();
      $center->run(fn () => \Illuminate\Support\Facades\DB::table('center_grants')->insert(['user_id' => $user->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now()]));
    `, slug, email);
    runFixture(String.raw`
      $center = \App\Models\Center::where('slug', getenv('COURSES_BROWSER_SLUG'))->firstOrFail();
      $user = \App\Models\User::where('email', getenv('COURSES_BROWSER_EMAIL'))->firstOrFail();
      \App\Models\CenterMembership::where('tenant_id', $center->id)->where('user_id', $user->id)->update(['status' => 'suspended']);
    `, slug, email);
    await page.reload();
    await expect(page.getByRole("heading", { name: "أُوقفت عضويتك في هذا المركز" })).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);
    const suspended = await page.evaluate(async () => {
      const response = await fetch("/api/v1/center/user", { headers: { Accept: "application/json" } });
      return { status: response.status, body: await response.json() };
    });
    expect(suspended).toEqual({ status: 403, body: { code: "membership_suspended" } });
    await page.goto(`${host}/login`);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
    await page.getByRole("textbox", { name: "كلمة المرور" }).fill(password);
    await page.getByRole("button", { name: "دخول المركز" }).click();
    await expect(page.locator(".notice[role=alert]")).toContainText("أُوقفت عضويتك");
    runFixture(String.raw`
      $center = \App\Models\Center::where('slug', getenv('COURSES_BROWSER_SLUG'))->firstOrFail();
      $user = \App\Models\User::where('email', getenv('COURSES_BROWSER_EMAIL'))->firstOrFail();
      \App\Models\CenterMembership::where('tenant_id', $center->id)->where('user_id', $user->id)->update(['status' => 'active']);
    `, slug, email);
    await page.goto(`${host}/login`);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
    await page.getByRole("textbox", { name: "كلمة المرور" }).fill(password);
    await page.getByRole("button", { name: "دخول المركز" }).click();
    await expect(page).toHaveURL(`${host}/admin`);
    await expect(page.getByText("مالك المركز")).toBeVisible();
    const sequence = Number(runFixture(String.raw`
      echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence');
    `, slug, email));
    await page.reload();
    await expect(page.getByText("مالك المركز")).toBeVisible();
    let pageRequests: { uri: string; queries: number }[] = [];
    await expect.poll(() => {
      pageRequests = JSON.parse(runFixture(String.raw`
      $rows = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
        ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TELESCOPE_SEQUENCE'))
        ->get(['content']);
      $requests = $rows->map(fn ($row) => json_decode($row->content, true))
        ->filter(fn ($entry) => ($entry['headers']['host'] ?? null) === getenv('COURSES_BROWSER_SLUG').'.courses.test')
        ->map(fn ($entry) => [
          'uri' => $entry['uri'],
          'queries' => (int) ($entry['response_headers']['x-courses-query-count'] ?? -1),
        ])->values()->all();
      echo json_encode($requests);
      `, slug, email, { COURSES_TELESCOPE_SEQUENCE: String(sequence) })) as { uri: string; queries: number }[];
      return pageRequests.length;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(pageRequests).toHaveLength(1);
    expect(pageRequests[0].uri).toBe("/api/v1/center/user");
    expect(pageRequests.every(({ queries }) => Number.isInteger(queries) && queries >= 0)).toBe(true);
    expect(pageRequests.reduce((total, request) => total + request.queries, 0)).toBeLessThanOrEqual(6);
    const owner = await page.evaluate(async () => {
      const response = await fetch("/api/v1/center/user", { headers: { Accept: "application/json" } });
      return { status: response.status, queries: Number(response.headers.get("X-Courses-Query-Count")), data: await response.json() };
    });
    expect(owner.status).toBe(200);
    expect(owner.queries).toBeLessThanOrEqual(6);
    expect(owner.data.membership.status).toBe("active");
    expect(owner.data.permissions.center_roles).toEqual(["center_owner"]);
    const cookies = await page.context().cookies(host);
    expect(cookies.some((cookie) => cookie.name.includes("session") && cookie.domain === `${slug}.courses.test`)).toBe(true);
    const platformCookies = await page.context().cookies("http://courses.test");
    expect(platformCookies.some((cookie) => cookie.name.includes("session"))).toBe(false);

    await page.goto(`${host}/admin/security`);
    await page.getByRole("textbox", { name: "كلمة المرور الحالية" }).fill(password);
    await page.getByRole("button", { name: "تفعيل التحقق بخطوتين" }).click();
    const secret = (await page.getByLabel("مفتاح المصادقة").textContent())?.trim();
    if (!secret) throw new Error("MFA setup did not show a secret.");
    await page.getByRole("textbox", { name: "رمز التحقق" }).fill(oneTimeCode(secret));
    await page.getByRole("button", { name: "تفعيل التحقق", exact: true }).click();
    await expect(page.getByRole("heading", { name: "التحقق بخطوتين مفعّل" })).toBeVisible();

    await page.goto(`${host}/admin`);
    const expiredSession = (await page.context().cookies(host)).find((cookie) => cookie.name.includes("session"));
    if (!expiredSession) throw new Error("The center session cookie was missing before logout.");
    await page.getByRole("button", { name: "تسجيل الخروج" }).click();
    await expect(page).toHaveURL(`${host}/login`);
    await page.goBack();
    await expect(page.getByText(email)).toHaveCount(0);
    const afterLogout = await page.evaluate(async () => (await fetch("/api/v1/center/user", { headers: { Accept: "application/json" } })).status);
    expect(afterLogout).toBe(401);
    await page.context().addCookies([expiredSession]);
    await page.goto(`${host}/admin`);
    await expect(page).toHaveURL(`${host}/login?expired=1`);
    await expect(page.getByRole("status")).toContainText("انتهت جلسة الدخول");

    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
    await page.getByRole("textbox", { name: "كلمة المرور" }).fill(password);
    const loginResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/center/auth/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "دخول المركز" }).click();
    expect((await loginResponse).status()).toBe(202);
    await expect(page.getByRole("heading", { name: "تحقق من هويتك" })).toBeVisible();
    let authenticated = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("textbox", { name: "رمز التحقق" }).fill(oneTimeCode(secret));
      const challengeResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/center/auth/mfa/challenge") && response.request().method() === "POST");
      await page.getByRole("button", { name: "تحقق وادخل" }).click();
      const response = await challengeResponse;
      if (response.status() === 429) {
        await page.waitForTimeout((Number(response.headers()["retry-after"] ?? "60") + 1) * 1_000);
        continue;
      }
      expect(response.ok()).toBe(true);
      authenticated = true;
      break;
    }
    expect(authenticated).toBe(true);
    await expect(page).toHaveURL(`${host}/admin`);
    await expect(page.getByText("مالك المركز")).toBeVisible();
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

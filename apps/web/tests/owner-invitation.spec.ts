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

type MeasuredRequest = { uri: string; queries: number };

function telescopeSequence(slug: string, email: string): number {
  return Number(runFixture(String.raw`
    echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence');
  `, slug, email));
}

function telescopeRequestsSince(slug: string, email: string, sequence: number): MeasuredRequest[] {
  return JSON.parse(runFixture(String.raw`
    $rows = \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
      ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TELESCOPE_SEQUENCE'))
      ->get(['content']);
    echo json_encode($rows->map(fn ($row) => json_decode($row->content, true))
      ->filter(fn ($entry) => ($entry['headers']['host'] ?? null) === getenv('COURSES_BROWSER_SLUG').'.courses.test')
      ->map(fn ($entry) => [
        'uri' => $entry['uri'],
        'queries' => (int) ($entry['response_headers']['x-courses-query-count'] ?? -1),
      ])->values()->all());
  `, slug, email, { COURSES_TELESCOPE_SEQUENCE: String(sequence) })) as MeasuredRequest[];
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

test("first owner accepts, signs in with MFA, sees current roles, and signs out on the center host", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const slug = `inv-${randomBytes(6).toString("hex")}`;
  const email = `${slug}@courses.test`;
  const staffEmail = `${slug}-staff@courses.test`;
  const secondManagerEmail = `${slug}-manager-two@courses.test`;
  const host = `http://${slug}.courses.test`;
  const password = randomBytes(24).toString("base64url");
  const staffPassword = randomBytes(24).toString("base64url");
  const secondManagerPassword = randomBytes(24).toString("base64url");
  const staffPage = await browser.newPage();
  const secondManagerPage = await browser.newPage();

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
    for (const [name, branchSlug] of [["فرع التجربة الشمالي", "pilot-north"], ["فرع التجربة الجنوبي", "pilot-south"]]) {
      await page.getByRole("button", { name: "إنشاء فرع" }).click();
      await page.getByRole("textbox", { name: "اسم الفرع" }).fill(name);
      await page.getByRole("textbox", { name: "رمز الفرع" }).fill(branchSlug);
      const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/center/branches") && response.request().method() === "POST");
      await page.getByRole("button", { name: "حفظ الفرع" }).click();
      expect((await created).status()).toBe(201);
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }
    const northCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "فرع التجربة الشمالي" }) });
    await northCard.getByRole("button", { name: "تعديل بيانات الفرع" }).click();
    await northCard.getByRole("textbox", { name: "اسم الفرع" }).fill("فرع التجربة الشمالي المحدّث");
    await northCard.getByRole("textbox", { name: "العنوان" }).fill("شارع التجربة ١");
    const updated = page.waitForResponse((response) => /\/api\/v1\/center\/branches\/\d+$/.test(response.url()) && response.request().method() === "PATCH");
    await northCard.getByRole("button", { name: "حفظ التعديل" }).click();
    expect((await updated).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "فرع التجربة الشمالي المحدّث" })).toBeVisible();
    await expect(page.getByRole("article").filter({ has: page.getByRole("heading", { name: "فرع التجربة الشمالي المحدّث" }) })).toContainText("شارع التجربة ١");
    await expect(page.getByRole("heading", { name: "فرع التجربة الجنوبي" })).toBeVisible();
    await page.getByRole("button", { name: "إنشاء فرع" }).click();
    await page.getByRole("textbox", { name: "اسم الفرع" }).fill("فرع التجربة الشرقي");
    await page.getByRole("textbox", { name: "رمز الفرع" }).fill("pilot-east");
    await page.getByRole("button", { name: "حفظ الفرع" }).click();
    await expect(page.getByRole("heading", { name: "فرع التجربة الشرقي" })).toBeVisible();

    await page.goto(`${host}/admin/members`);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(staffEmail);
    const staffInvitationResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/center/members/invitations") && response.request().method() === "POST");
    await page.getByRole("button", { name: "إرسال الدعوة" }).click();
    expect((await staffInvitationResponse).status()).toBe(201);
    await expect(page.getByText(staffEmail)).toBeVisible();
    await expect(page.getByText("بانتظار القبول")).toBeVisible();

    let staffInvitation = "";
    await expect.poll(async () => {
      const inbox = await (await fetch("http://127.0.0.1:8025/api/v1/messages")).json();
      for (const message of inbox.messages as { ID: string; To: { Address: string }[] }[]) {
        if (!message.To.some((recipient) => recipient.Address === staffEmail)) continue;
        const detail = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)).json();
        staffInvitation = String(detail.Text ?? "").match(new RegExp(`http:\\/\\/${slug}\\.courses\\.test\\/invitations\\/[^\\s<>"']+`))?.[0] ?? "";
        if (staffInvitation) break;
      }
      return Boolean(staffInvitation);
    }, { timeout: 10_000 }).toBe(true);
    await staffPage.goto(staffInvitation);
    await expect(staffPage.getByText(staffEmail)).toBeVisible();
    await staffPage.getByRole("textbox", { name: "الاسم" }).fill("Pilot Staff");
    await staffPage.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(staffPassword);
    await staffPage.getByRole("textbox", { name: "تأكيد كلمة المرور" }).fill(staffPassword);
    await staffPage.getByRole("button", { name: "قبول الدعوة" }).click();
    await expect(staffPage).toHaveURL(`${host}/login?invitation=accepted`);
    await staffPage.goto(staffInvitation);
    await expect(staffPage.getByRole("button", { name: "قبول الدعوة" })).toHaveCount(0);
    await staffPage.goto(`${host}/login`);
    await staffPage.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(staffEmail);
    await staffPage.getByRole("textbox", { name: "كلمة المرور" }).fill(staffPassword);
    await staffPage.getByRole("button", { name: "دخول المركز" }).click();
    await expect(staffPage).toHaveURL(`${host}/admin`);
    await expect(staffPage.getByText(staffEmail)).toBeVisible();

    const memberSequence = telescopeSequence(slug, email);
    await page.reload();
    const staffCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Pilot Staff" }) });
    await expect(staffCard).toContainText("نشط");
    await expect(page.getByText(staffEmail)).toHaveCount(1);
    let memberRequests: MeasuredRequest[] = [];
    await expect.poll(() => {
      memberRequests = telescopeRequestsSince(slug, email, memberSequence);
      return memberRequests.length;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(memberRequests).toHaveLength(1);
    expect(memberRequests[0].uri).toBe("/api/v1/center/member-workspace");
    expect(memberRequests[0].queries).toBeLessThanOrEqual(6);

    runFixture(String.raw`
      $center = \App\Models\Center::where('slug', getenv('COURSES_BROWSER_SLUG'))->firstOrFail();
      $manager = \App\Models\User::factory()->create([
        'name' => 'Second Branch Manager',
        'email' => getenv('COURSES_MANAGER_TWO_EMAIL'),
        'password' => getenv('COURSES_MANAGER_TWO_PASSWORD'),
      ]);
      $manager->markEmailAsVerified();
      \App\Models\CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $manager->id, 'status' => 'active']);
    `, slug, email, { COURSES_MANAGER_TWO_EMAIL: secondManagerEmail, COURSES_MANAGER_TWO_PASSWORD: secondManagerPassword });
    await page.reload();
    const firstManagerCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Pilot Staff" }) });
    await firstManagerCard.getByRole("button", { name: "تعديل الأدوار" }).click();
    await firstManagerCard.getByRole("group", { name: "فرع التجربة الشمالي المحدّث" }).getByRole("checkbox", { name: "مدير الفرع" }).check();
    await firstManagerCard.getByRole("group", { name: "فرع التجربة الشمالي المحدّث" }).getByRole("checkbox", { name: "تدقيق الفرع" }).check();
    await firstManagerCard.getByRole("group", { name: "فرع التجربة الجنوبي" }).getByRole("checkbox", { name: "مدير الفرع" }).check();
    await firstManagerCard.getByRole("button", { name: "حفظ الأدوار" }).click();
    await expect(page.getByText("حُفظت أدوار الموظف وإسنادات فروعه.")).toBeVisible();
    const secondManagerCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Second Branch Manager" }) });
    await secondManagerCard.getByRole("button", { name: "تعديل الأدوار" }).click();
    await secondManagerCard.getByRole("group", { name: "فرع التجربة الشمالي المحدّث" }).getByRole("checkbox", { name: "مدير الفرع" }).check();
    await secondManagerCard.getByRole("group", { name: "فرع التجربة الشمالي المحدّث" }).getByRole("checkbox", { name: "تدقيق الفرع" }).check();
    await secondManagerCard.getByRole("button", { name: "حفظ الأدوار" }).click();
    await expect(secondManagerCard.getByRole("button", { name: "تعديل الأدوار" })).toBeVisible();

    const firstManagerSequence = telescopeSequence(slug, email);
    await staffPage.reload();
    let firstManagerRequests: MeasuredRequest[] = [];
    await expect.poll(() => {
      firstManagerRequests = telescopeRequestsSince(slug, email, firstManagerSequence);
      return firstManagerRequests.length;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(firstManagerRequests).toHaveLength(1);
    expect(firstManagerRequests[0].uri).toBe("/api/v1/center/user");
    expect(firstManagerRequests[0].queries).toBeLessThanOrEqual(6);
    await expect(staffPage.getByRole("heading", { name: "فرع التجربة الشمالي المحدّث" })).toBeVisible();
    await expect(staffPage.getByRole("heading", { name: "فرع التجربة الجنوبي" })).toBeVisible();
    await expect(staffPage.getByRole("heading", { name: "فرع التجربة الشرقي" })).toHaveCount(0);
    const auditSequence = telescopeSequence(slug, email);
    await staffPage.goto(`${host}/admin/audit`);
    await expect(staffPage.getByRole("heading", { name: "سجل التدقيق" })).toBeVisible();
    await expect(staffPage.getByRole("heading", { name: "تغيير أدوار الفرع" }).first()).toBeVisible();
    let auditRequests: MeasuredRequest[] = [];
    await expect.poll(() => {
      auditRequests = telescopeRequestsSince(slug, email, auditSequence);
      return auditRequests.length;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(auditRequests).toHaveLength(1);
    expect(auditRequests[0].uri).toContain("/api/v1/center/user");
    expect(auditRequests[0].queries).toBeLessThanOrEqual(6);

    await secondManagerPage.goto(`${host}/login`);
    await secondManagerPage.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(secondManagerEmail);
    await secondManagerPage.getByRole("textbox", { name: "كلمة المرور" }).fill(secondManagerPassword);
    await secondManagerPage.getByRole("button", { name: "دخول المركز" }).click();
    await expect(secondManagerPage).toHaveURL(`${host}/admin`);
    await expect(secondManagerPage.getByRole("heading", { name: "فرع التجربة الشمالي المحدّث" })).toBeVisible();
    await expect(secondManagerPage.getByRole("heading", { name: "فرع التجربة الجنوبي" })).toHaveCount(0);
    const southId = Number(runFixture(String.raw`
      $center = \App\Models\Center::where('slug', getenv('COURSES_BROWSER_SLUG'))->firstOrFail();
      echo $center->run(fn () => \Illuminate\Support\Facades\DB::table('branches')->where('slug', 'pilot-south')->value('id'));
    `, slug, email));
    const deniedSouth = await secondManagerPage.evaluate(async (id) => {
      const response = await fetch(`/api/v1/center/branches/${id}`, { headers: { Accept: "application/json" } });
      return response.status;
    }, southId);
    expect(deniedSouth).toBe(403);
    await expect(staffPage.getByText(`فرع رقم ${southId}`)).toHaveCount(0);
    await firstManagerCard.getByRole("button", { name: "تعديل الأدوار" }).click();
    await firstManagerCard.getByRole("checkbox", { name: "مسؤول المركز" }).check();
    const adminGrant = page.waitForResponse((response) => response.url().includes("/api/v1/center/members/") && response.url().endsWith("/grants") && response.request().method() === "PUT");
    await firstManagerCard.getByRole("button", { name: "حفظ الأدوار" }).click();
    expect((await adminGrant).status()).toBe(200);
    await expect(firstManagerCard).toContainText("مسؤول المركز");
    await staffPage.goto(`${host}/admin`);
    await expect(staffPage.getByRole("heading", { name: "فرع التجربة الشرقي" })).toBeVisible();
    await staffPage.goto(`${host}/admin/settings`);
    await staffPage.getByRole("textbox", { name: "بريد التواصل" }).fill("office@alpha.test");
    await staffPage.getByRole("button", { name: "حفظ الإعدادات" }).click();
    await expect(staffPage.getByText("حُفظت إعدادات المركز.")).toBeVisible();
    await staffPage.goto(`${host}/admin/members`);
    const ownerCard = staffPage.getByRole("article").filter({ has: staffPage.getByRole("heading", { name: "Browser Owner" }) });
    await expect(ownerCard).toBeVisible();
    await expect(ownerCard.getByRole("button", { name: "تعديل الأدوار" })).toHaveCount(0);
    await ownerCard.getByRole("button", { name: "إيقاف العضوية" }).click();
    await staffPage.getByRole("dialog").getByRole("button", { name: "إيقاف العضوية" }).click();
    await expect(staffPage.locator(".notice[role=alert]")).toContainText("لا يمكن إيقاف آخر مالك نشط للمركز");
    await expect(ownerCard).toContainText("نشط");
    await staffPage.goto(`${host}/admin`);

    await staffCard.getByRole("button", { name: "إيقاف العضوية" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "إيقاف العضوية" }).click();
    await expect(staffCard).toContainText("موقوف");
    await secondManagerPage.goto(`${host}/admin/audit`);
    await expect(secondManagerPage.getByRole("heading", { name: "تغيير حالة موظف الفرع" })).toBeVisible();
    await expect(secondManagerPage.getByText(`فرع رقم ${southId}`)).toHaveCount(0);
    await staffPage.reload();
    await expect(staffPage.getByRole("heading", { name: "أُوقفت عضويتك في هذا المركز" })).toBeVisible();
    await expect(staffPage.getByText(staffEmail)).toHaveCount(0);
    await staffCard.getByRole("button", { name: "تنشيط العضوية" }).click();
    await expect(staffCard).toContainText("نشط");
    await staffPage.reload();
    await expect(staffPage.getByText(staffEmail)).toBeVisible();
    const expiredEmail = `${slug}-expired@courses.test`;
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(expiredEmail);
    await page.getByRole("button", { name: "إرسال الدعوة" }).click();
    await expect(page.getByText(expiredEmail)).toBeVisible();
    runFixture(String.raw`
      $center = \App\Models\Center::where('slug', getenv('COURSES_BROWSER_SLUG'))->firstOrFail();
      \App\Models\CenterInvitation::where('tenant_id', $center->id)
        ->where('email', $center->slug.'-expired@courses.test')
        ->update(['sent_at' => null]);
    `, slug, email);
    await page.reload();
    await expect(page.locator(".member-card").filter({ hasText: expiredEmail })).toContainText("التسليم غير مؤكد");
    runFixture(String.raw`
      $center = \App\Models\Center::where('slug', getenv('COURSES_BROWSER_SLUG'))->firstOrFail();
      \App\Models\CenterInvitation::where('tenant_id', $center->id)
        ->where('email', $center->slug.'-expired@courses.test')
        ->update(['sent_at' => now(), 'expires_at' => now()->subMinute()]);
    `, slug, email);
    await page.reload();
    await expect(page.locator(".member-card").filter({ hasText: expiredEmail })).toContainText("انتهت صلاحية الدعوة");
    await page.goto(`${host}/admin`);
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
    const sequence = telescopeSequence(slug, email);
    await page.reload();
    await expect(page.getByText("مالك المركز")).toBeVisible();
    let pageRequests: MeasuredRequest[] = [];
    await expect.poll(() => {
      pageRequests = telescopeRequestsSince(slug, email, sequence);
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
    const afterLogout = await page.request.get(`${host}/api/v1/center/user`, { headers: { Accept: "application/json" } });
    expect(afterLogout.status()).toBe(401);
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
    await staffPage.close();
    await secondManagerPage.close();
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
        \App\Models\User::where('email', $slug.'-staff@courses.test')->delete();
        \App\Models\User::where('email', $slug.'-manager-two@courses.test')->delete();
      }
    `, slug, email);
  }
});

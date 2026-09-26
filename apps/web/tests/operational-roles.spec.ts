import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { apiDirectory, php } from "./platform-fixtures";
import { expect, test, type Page } from "@playwright/test";
import { credentials, ensureLocalFixtures, invitationUrl, signIn } from "./local-fixtures";
import type { MemberContext } from "../lib/server-context";

const host = process.env.COURSES_TEST_CENTER_URL ?? "http://alpha.courses.test";

async function save(page: Page, id: number, payload: object) {
  return page.evaluate(async ({ id, payload }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin" });
    const token = document.cookie.split("; ").find((part) => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/members/${id}/grants`, {
      method: "PUT", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(payload),
    });
    return response.status;
  }, { id, payload });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await ensureLocalFixtures(browser);
});

test("combined branch roles persist, sensitive grants stay separate, and open pages lose revoked authority", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  owner.setDefaultTimeout(10_000);
  staff.setDefaultTimeout(10_000);
  const ownerCredentials = credentials("alpha");
  const staffCredentials = { email: `roles-browser-${Date.now()}@courses.test`, password: randomBytes(24).toString("base64url") };
  let original: MemberContext["members"][number] | undefined;
  try {
    await signIn(owner, host, ownerCredentials.email, ownerCredentials.password);
    await owner.goto(`${host}/admin/members`);
    await owner.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(staffCredentials.email);
    await owner.getByRole("button", { name: "إرسال الدعوة" }).click();
    await expect(owner.getByRole("status")).toContainText("أُرسلت الدعوة");
    await staff.goto((await invitationUrl(staffCredentials.email, new URL(host).hostname)).replace("http://alpha.courses.test", host));
    await staff.getByRole("textbox", { name: "الاسم" }).fill("Operational Roles Demo");
    await staff.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(staffCredentials.password);
    await staff.getByRole("textbox", { name: "تأكيد كلمة المرور" }).fill(staffCredentials.password);
    await staff.getByRole("button", { name: "قبول الدعوة" }).click();
    await expect(staff).toHaveURL(/\/login\?invitation=accepted/);
    const workspace = await (await owner.request.get(`${host}/api/v1/center/member-workspace`)).json() as MemberContext;
    original = workspace.members.find((member) => member.user.email === staffCredentials.email)!;
    expect(original).toBeTruthy();
    const north = workspace.branches.find((branch) => branch.slug === "north")!;
    const south = workspace.branches.find((branch) => branch.slug === "south")!;
    expect(await save(owner, original.id, { center_roles: [], branch_roles: {} })).toBe(200);
    const cursor = Number(execFileSync(php, ["artisan", "tinker", "--no-interaction", String.raw`--execute=echo \Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')->max('sequence') ?? 0;`], { cwd: apiDirectory, stdio: "pipe" }).toString().trim());
    await owner.goto(`${host}/admin/members`);
    await expect.poll(() => {
      const counts = JSON.parse(execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
        echo json_encode(\Illuminate\Support\Facades\DB::connection('central')->table('telescope_entries')
          ->where('type', 'request')->where('sequence', '>', (int) getenv('COURSES_TEST_CURSOR'))
          ->whereRaw("content::jsonb->'headers'->>'host' = ?", ['alpha.courses.test'])
          ->pluck('content')->map(fn ($row) => (int) (json_decode($row, true)['response_headers']['x-courses-query-count'] ?? 0))->all());
      `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_CURSOR: String(cursor) }, stdio: "pipe" }).toString().trim()) as number[];
      return counts.length > 0 && counts.every((count) => count > 0) && counts.reduce((sum, count) => sum + count, 0) <= 6;
    }).toBe(true);
    const memberSearch = owner.getByRole("searchbox", { name: "بحث في العضويات" });
    if (await memberSearch.count()) await memberSearch.fill(staffCredentials.email);
    const row = owner.getByRole("row").filter({ hasText: staffCredentials.email }).or(owner.locator("article.member-card").filter({ hasText: staffCredentials.email }));
    await row.getByRole("button", { name: "تعديل الأدوار" }).click();
    const editor = owner.getByRole("region", { name: `أدوار ${original.user.name}` });
    await editor.getByRole("group", { name: north.name, exact: true }).getByRole("checkbox", { name: "التسجيل", exact: true }).check();
    await editor.getByRole("group", { name: north.name, exact: true }).getByRole("checkbox", { name: "الحضور", exact: true }).check();
    await editor.getByRole("group", { name: south.name, exact: true }).getByRole("checkbox", { name: "الحسابات", exact: true }).check();
    await editor.getByRole("button", { name: "حفظ الأدوار", exact: true }).click();
    await owner.getByRole("dialog").getByRole("button", { name: "حفظ التغيير" }).click();
    await expect(owner.getByRole("status")).toContainText("حُفظت أدوار الموظف");
    await signIn(staff, host, staffCredentials.email, staffCredentials.password);
    let response = await staff.request.get(`${host}/api/v1/center/user`);
    expect(response.status()).toBe(200);
    expect(Number(response.headers()["x-courses-query-count"])).toBeLessThanOrEqual(6);
    let actions = (await response.json()).user.permissions.branch_actions;
    expect(actions[north.id]).toContain("attendance.close");
    expect(actions[north.id]).not.toContain("fees.discount");
    expect(actions[south.id]).toContain("payments.record");
    expect(actions[south.id]).not.toContain("finance.approve");
    expect((await staff.request.get(`${host}/api/v1/center/member-workspace`)).status()).toBe(403);
    expect(await save(staff, original.id, { center_roles: ["center_owner"], branch_roles: {} })).toBe(403);
    await row.getByRole("button", { name: "تعديل الأدوار" }).click();
    await editor.getByRole("group", { name: north.name, exact: true }).getByRole("checkbox", { name: "خصم الرسوم بسبب مسجل" }).check();
    await editor.getByRole("button", { name: "حفظ الأدوار", exact: true }).click();
    await owner.getByRole("dialog").getByRole("button", { name: "حفظ التغيير" }).click();
    await expect(owner.getByRole("status")).toContainText("حُفظت أدوار الموظف");
    response = await staff.request.get(`${host}/api/v1/center/user`);
    actions = (await response.json()).user.permissions.branch_actions;
    expect(actions[north.id]).toContain("fees.discount");
    expect(actions[north.id]).not.toContain("finance.approve");
    expect(await save(owner, original.id, { center_roles: [], branch_roles: {} })).toBe(200);
    expect((await staff.request.get(`${host}/api/v1/center/branches/${north.id}`)).status()).toBe(403);
    const audit = await (await owner.request.get(`${host}/api/v1/center/audit`)).json();
    expect(audit.entries.some((entry: { event: string; details: string }) => entry.event === "member.grants_changed" && JSON.parse(entry.details).user_id === original!.user.id)).toBe(true);

    // A stale open editor cannot overwrite a newer assignment.
    await row.getByRole("button", { name: "تعديل الأدوار" }).click();
    const currentWorkspace = await (await owner.request.get(`${host}/api/v1/center/member-workspace`)).json() as MemberContext;
    expect(await save(owner, original.id, { center_roles: [], branch_roles: { [north.id]: ["attendance"] } })).toBe(200);
    await editor.getByRole("group", { name: north.name, exact: true }).getByRole("checkbox", { name: "الإدارة الأكاديمية", exact: true }).check();
    await editor.getByRole("button", { name: "حفظ الأدوار", exact: true }).click();
    await owner.getByRole("dialog").getByRole("button", { name: "حفظ التغيير" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "تغيّرت صلاحيات الموظف" })).toContainText("تغيّرت صلاحيات الموظف");
    expect(currentWorkspace.members.find((member) => member.id === original!.id)?.grant_revision).toBeTruthy();
    await row.getByRole("button", { name: "تعديل الأدوار" }).click();
    await expect(editor.getByRole("group", { name: north.name, exact: true }).getByRole("checkbox", { name: "الحضور", exact: true })).toBeChecked();
    await owner.screenshot({ path: "/tmp/courses-issue20/roles-desktop.png", fullPage: true });
    await owner.getByRole("button", { name: "إلغاء", exact: true }).click();
    await owner.setViewportSize({ width: 390, height: 844 });
    await row.getByRole("button", { name: "تعديل الأدوار" }).click();
    await expect(editor.getByRole("checkbox", { name: "الإدارة الأكاديمية", exact: true }).first()).toBeVisible();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await owner.screenshot({ path: "/tmp/courses-issue20/roles-mobile.png", fullPage: true });
    await owner.getByRole("button", { name: "إلغاء", exact: true }).click();
    await expect(row.getByRole("button", { name: "تعديل الأدوار" })).toBeFocused();
    const latest = await (await owner.request.get(`${host}/api/v1/center/member-workspace`)).json() as MemberContext;
    const latestMember = latest.members.find((member) => member.id === original!.id)!;
    const shared = { center_roles: [], grant_revision: latestMember.grant_revision, branch_scope: latest.branches.map((branch) => branch.id) };
    const concurrent = await Promise.all([
      save(owner, original.id, { ...shared, branch_roles: { [north.id]: ["registration"] } }),
      save(owner, original.id, { ...shared, branch_roles: { [south.id]: ["accounting"] } }),
    ]);
    expect(concurrent.sort()).toEqual([200, 409]);
    await owner.goto(`${host}/admin/audit`);
    const change = owner.getByText("عرض تغيير الأدوار", { exact: true }).first();
    await change.click();
    await expect(change.locator("..")).toContainText("قبل التغيير");
    await expect(change.locator("..")).toContainText("بعد التغيير");

  } finally {
    execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
      if (!app()->isLocal() || config('database.connections.central.database') !== 'courses_central') throw new \RuntimeException('Local fixture cleanup only');
      $email = getenv('COURSES_TEST_EMAIL');
      if (!preg_match('/^roles-browser-[0-9]+@courses\.test$/', $email)) throw new \RuntimeException('Unexpected fixture');
      $user = \App\Models\User::where('email', $email)->first();
      $center = \App\Models\Center::where('slug', 'alpha')->firstOrFail();
      if ($user) {
        $center->run(function () use ($user) {
          \Illuminate\Support\Facades\DB::table('center_grants')->where('user_id', $user->id)->delete();
          \Illuminate\Support\Facades\DB::table('branch_grants')->where('user_id', $user->id)->delete();
        });
        \App\Models\CenterMembership::where('tenant_id', $center->id)->where('user_id', $user->id)->delete();
        $user->delete();
      }
      \App\Models\CenterInvitation::where('tenant_id', $center->id)->where('email', $email)->delete();
    `], { cwd: apiDirectory, env: { ...process.env, COURSES_TEST_EMAIL: staffCredentials.email }, stdio: "pipe" });
    await owner.close(); await staff.close();
  }
});

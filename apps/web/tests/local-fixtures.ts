import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";

const credentialsDir = path.resolve(process.cwd(), "../api/storage/app/private");
const php = process.env.COURSES_PHP_BIN ?? (process.platform === "darwin" ? "php85" : "php");

export function setLocalCenterSuspended(slug: "alpha" | "beta", suspended: boolean) {
  execFileSync(php, ["artisan", "tinker", "--no-interaction", "--execute=" + String.raw`
    if (config('database.connections.central.database') !== 'courses_central') {
      throw new \RuntimeException('Local browser tests require courses_central');
    }
    $slug = getenv('COURSES_TEST_SLUG');
    if (!in_array($slug, ['alpha', 'beta'], true)) {
      throw new \RuntimeException('Unexpected local center slug');
    }
    \App\Models\Center::where('slug', $slug)->firstOrFail()
      ->update(['suspended' => getenv('COURSES_TEST_SUSPENDED') === '1']);
  `], {
    cwd: path.resolve(process.cwd(), "../api"),
    env: { ...process.env, COURSES_TEST_SLUG: slug, COURSES_TEST_SUSPENDED: suspended ? "1" : "0" },
    stdio: "pipe",
  });
}

export function credentials(name: "alpha" | "beta" | "staff") {
  const file = path.join(credentialsDir, `local-${name}-credentials.txt`);
  if (!existsSync(file)) throw new Error(`Missing ${file}. Run npm run test:browser after courses:bootstrap-local.`);
  const lines = readFileSync(file, "utf8").split("\n");
  const value = (key: string) => lines.find((line) => line.startsWith(key))?.slice(key.length);
  const email = value("Email: ") ?? value("email=");
  const password = value("Password: ") ?? value("password=");
  if (!email || !password) throw new Error(`Invalid ${name} local credentials file.`);
  return { file, email, password };
}

export async function signIn(page: Page, host: string, email: string, password: string) {
  await page.goto(`${host}/login`);
  let signedIn = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(email);
    await page.getByRole("textbox", { name: "كلمة المرور" }).fill(password);
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/center/auth/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "دخول المركز" }).click();
    const response = await responsePromise;
    if (response.status() === 429) {
      const retryAfter = Number(response.headers()["retry-after"] ?? "60");
      await page.waitForTimeout((retryAfter + 1) * 1_000);
      continue;
    }
    if (response.status() === 202) {
      throw new Error(`MFA is enabled for ${email}. Disable it in أمان الحساب with the authenticator before running the local browser suite.`);
    }
    if (response.status() === 422 || response.status() === 403) {
      throw new Error(`The local sample credential for ${email} is stale. If the local databases were reset, remove the ignored local sample credential files, run courses:bootstrap-local, then rerun this suite.`);
    }
    expect(response.ok()).toBe(true);
    signedIn = true;
    break;
  }
  expect(signedIn).toBe(true);
  await expect(page).toHaveURL(`${host}/admin`);
}

async function invitationUrl(email: string, host: string): Promise<string> {
  let url = "";
  await expect.poll(async () => {
    const response = await fetch("http://127.0.0.1:8025/api/v1/messages");
    const data = await response.json();
    for (const summary of data.messages.filter((message: { To: { Address: string }[] }) =>
      message.To.some((to) => to.Address === email))) {
      const detail = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${summary.ID}`)).json();
      const candidate = String(detail.Text ?? "").match(new RegExp(`https?:\\/\\/${host}\\/invitations\\/[^\\s<>"']+`))?.[0];
      if (candidate) {
        // The invitation API checks whether this Mailpit token is still unused.
        const token = candidate.split("/").pop();
        const valid = await fetch(`http://${host}/api/v1/center/invitations/${token}`, { headers: { Accept: "application/json" } });
        if (valid.ok) { url = candidate; break; }
      }
    }
    return Boolean(url);
  }, { timeout: 10_000 }).toBe(true);
  return url;
}

async function acceptInvitation(browser: Browser, name: "alpha" | "beta" | "staff", email: string, displayName: string, host: string) {
  const page = await browser.newPage();
  try {
    await page.goto(await invitationUrl(email, host));
    await expect(page.getByRole("heading", { name: "ابدأ عضويتك" })).toBeVisible();
    const password = randomBytes(24).toString("base64url");
    await page.getByRole("textbox", { name: "الاسم" }).fill(displayName);
    await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(password);
    await page.getByRole("textbox", { name: "تأكيد كلمة المرور" }).fill(password);
    await page.getByRole("button", { name: "قبول الدعوة" }).click();
    await expect(page).toHaveURL(/\/login\?invitation=accepted/);
    writeFileSync(path.join(credentialsDir, `local-${name}-credentials.txt`), `email=${email}\npassword=${password}\n`, { mode: 0o600, flag: "wx" });
  } finally {
    await page.close();
  }
}

async function ensureBranch(page: Page, name: string, slug: string) {
  if (await page.getByRole("heading", { name, exact: true }).count()) return;
  await page.getByRole("button", { name: "إنشاء فرع" }).click();
  await page.getByRole("textbox", { name: "اسم الفرع" }).fill(name);
  await page.getByRole("textbox", { name: "رمز الفرع" }).fill(slug);
  await page.getByRole("button", { name: "حفظ الفرع" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

export async function ensureLocalFixtures(browser: Browser) {
  const alpha = "http://alpha.courses.test";
  const beta = "http://beta.courses.test";
  if (!existsSync(path.join(credentialsDir, "local-alpha-credentials.txt"))) {
    await acceptInvitation(browser, "alpha", "alpha-owner@courses.test", "Alpha Owner", "alpha.courses.test");
  }
  if (!existsSync(path.join(credentialsDir, "local-beta-credentials.txt"))) {
    await acceptInvitation(browser, "beta", "beta-owner@courses.test", "Beta Owner", "beta.courses.test");
  }

  const alphaOwner = credentials("alpha");
  const betaOwner = credentials("beta");
  const alphaPage = await browser.newPage();
  const betaPage = await browser.newPage();
  try {
    await signIn(alphaPage, alpha, alphaOwner.email, alphaOwner.password);
    await ensureBranch(alphaPage, "الفرع الشمالي", "north");
    await ensureBranch(alphaPage, "الفرع الجنوبي", "south");
    await signIn(betaPage, beta, betaOwner.email, betaOwner.password);
    await ensureBranch(betaPage, "beta-stable", "beta-stable");

    if (!existsSync(path.join(credentialsDir, "local-staff-credentials.txt"))) {
      await alphaPage.goto(`${alpha}/admin/members`);
      await alphaPage.getByRole("textbox", { name: "البريد الإلكتروني" }).fill("staff@courses.test");
      await alphaPage.getByRole("button", { name: "إرسال الدعوة" }).click();
      await expect(alphaPage.getByRole("status")).toContainText("أُرسلت الدعوة");
      await acceptInvitation(browser, "staff", "staff@courses.test", "Staff Demo", "alpha.courses.test");
      await alphaPage.reload();
      const staffCard = alphaPage.getByRole("article").filter({ has: alphaPage.getByRole("heading", { name: "Staff Demo" }) });
      await staffCard.getByRole("button", { name: "تعديل الأدوار" }).click();
      await staffCard.getByRole("group", { name: "الفرع الشمالي" }).getByRole("checkbox", { name: "عرض الفرع" }).check();
      await staffCard.getByRole("button", { name: "حفظ الأدوار" }).click();
      await expect(staffCard).toContainText("نشط");
    }
  } finally {
    await alphaPage.close();
    await betaPage.close();
  }
}

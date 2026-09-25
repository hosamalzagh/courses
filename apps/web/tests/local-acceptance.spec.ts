import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { credentials, ensureLocalFixtures, signIn } from "./local-fixtures";

const alpha = "http://alpha.courses.test";
const beta = "http://beta.courses.test";
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await ensureLocalFixtures(browser);
});

test("alpha and beta keep pages, sessions, and cached data separate", async ({ browser }) => {
  test.setTimeout(180_000);
  const alphaOwner = credentials("alpha");
  const betaOwner = credentials("beta");
  const alphaPage = await browser.newPage();
  const betaPage = await browser.newPage();
  try {
    await signIn(alphaPage, alpha, alphaOwner.email, alphaOwner.password);
    await expect(alphaPage.getByRole("heading", { name: "الفرع الشمالي" })).toBeVisible();
    await expect(alphaPage.getByText("beta-stable")).toHaveCount(0);
    await alphaPage.getByRole("button", { name: "إنشاء فرع" }).click();
    await alphaPage.getByRole("textbox", { name: "اسم الفرع" }).fill("Invalid QA Branch");
    await alphaPage.getByRole("textbox", { name: "رمز الفرع" }).fill("INVALID SLUG");
    await alphaPage.getByRole("button", { name: "حفظ الفرع" }).click();
    await expect(alphaPage.getByRole("textbox", { name: "رمز الفرع" })).toHaveAttribute("aria-invalid", "true");
    await expect(alphaPage.locator("#branch-slug-error")).toBeVisible();
    await alphaPage.goto(`${alpha}/admin/members`);
    const staffCard = alphaPage.getByRole("article").filter({ has: alphaPage.getByRole("heading", { name: "Staff Demo" }) });
    await staffCard.getByRole("button", { name: "إيقاف العضوية" }).click();
    await expect(alphaPage.getByRole("dialog")).toContainText("سيفقد هذا الموظف الوصول");
    await alphaPage.getByRole("dialog").getByRole("button", { name: "إلغاء" }).click();
    await expect(staffCard).toContainText("نشط");
    const csrfStatus = await alphaPage.evaluate(async () => {
      const response = await fetch("/api/v1/center/settings", {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "blocked" }),
      });
      return response.status;
    });
    expect(csrfStatus).toBe(419);
    await alphaPage.goto(`${beta}/admin`);
    await expect(alphaPage).toHaveURL(`${beta}/login`);
    await alphaPage.goto(`${alpha}/admin`);
    await expect(alphaPage.getByRole("heading", { name: "الفرع الشمالي" })).toBeVisible();

    await signIn(betaPage, beta, betaOwner.email, betaOwner.password);
    await expect(betaPage.getByRole("heading", { name: "beta-stable" })).toBeVisible();
    await expect(betaPage.getByText("الفرع الشمالي")).toHaveCount(0);
    await betaPage.reload();
    await expect(betaPage.getByRole("heading", { name: "beta-stable" })).toBeVisible();
    await betaPage.goto(`${alpha}/admin`);
    await expect(betaPage).toHaveURL(`${alpha}/login`);
  } finally {
    await alphaPage.close();
    await betaPage.close();
  }
});

test("Mailpit password reset changes the local staff password and permits login", async ({ page }) => {
  test.setTimeout(180_000);
  const staff = credentials("staff");
  const started = Date.now();
  await page.goto(`${alpha}/forgot-password`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(staff.email);
  let sent = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/center/auth/forgot-password") && response.request().method() === "POST");
    await page.getByRole("button", { name: "إرسال رابط الاستعادة" }).click();
    const response = await responsePromise;
    if (response.status() === 429) {
      const retryAfter = Number(response.headers()["retry-after"] ?? "60");
      await page.waitForTimeout((retryAfter + 1) * 1_000);
      continue;
    }
    expect(response.ok()).toBe(true);
    sent = true;
    break;
  }
  expect(sent).toBe(true);
  await expect(page.getByRole("status")).toContainText("أُرسلت رسالة الاستعادة");

  let messageId = "";
  await expect.poll(async () => {
    const response = await fetch("http://127.0.0.1:8025/api/v1/messages");
    const data = await response.json();
    messageId = data.messages.find((message: { ID: string; Created: string; To: { Address: string }[] }) =>
      Date.parse(message.Created) >= started - 2_000 && message.To.some((to) => to.Address === staff.email))?.ID ?? "";
    return Boolean(messageId);
  }, { timeout: 10_000 }).toBe(true);
  const message = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${messageId}`)).json();
  const resetUrl = String(message.Text ?? "").match(/https?:\/\/alpha\.courses\.test\/reset-password\/[^\s<>"']+/)?.[0];
  if (!resetUrl) throw new Error("The local reset email did not contain an alpha link.");
  await page.goto(resetUrl).catch(() => { throw new Error("Could not open the local reset link."); });
  const newPassword = randomBytes(24).toString("base64url");
  await page.getByRole("textbox", { name: "كلمة المرور الجديدة" }).fill(newPassword);
  await page.getByRole("textbox", { name: "تأكيد كلمة المرور" }).fill(newPassword);
  await page.getByRole("button", { name: "حفظ كلمة المرور" }).click();
  await expect(page.getByRole("status")).toContainText("حُفظت كلمة المرور");
  writeFileSync(staff.file, `email=${staff.email}\npassword=${newPassword}\n`, { mode: 0o600 });

  await page.goto(resetUrl);
  await page.getByRole("textbox", { name: "كلمة المرور الجديدة" }).fill(randomBytes(24).toString("base64url"));
  await page.getByRole("textbox", { name: "تأكيد كلمة المرور" }).fill("different-password");
  await page.getByRole("button", { name: "حفظ كلمة المرور" }).click();
  await expect(page.locator("#confirmation-error")).toContainText("تأكيد كلمة المرور غير مطابق");
  const replayPassword = randomBytes(24).toString("base64url");
  await page.getByRole("textbox", { name: "كلمة المرور الجديدة" }).fill(replayPassword);
  await page.getByRole("textbox", { name: "تأكيد كلمة المرور" }).fill(replayPassword);
  const replayResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/center/auth/reset-password") && response.request().method() === "POST");
  await page.getByRole("button", { name: "حفظ كلمة المرور" }).click();
  expect((await replayResponse).status()).toBe(422);
  await expect(page.locator(".notice[role=alert]")).toContainText("استُخدم بالفعل");

  await signIn(page, alpha, staff.email, newPassword);
  await expect(page.getByRole("heading", { name: "الفرع الشمالي" })).toBeVisible();
});

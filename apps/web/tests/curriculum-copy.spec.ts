import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(!process.env.COURSES_COPY_CREDENTIALS || !process.env.COURSES_COPY_QUERY_LOG,
  "Requires isolated center credentials and an SSR query log.");
const origin = process.env.COURSES_COPY_ORIGIN ?? "http://alpha.courses.test:8086";
const credentials = process.env.COURSES_COPY_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_COPY_CREDENTIALS, "utf8")) : {};

async function signIn(page: Page, who: "alpha" | "beta", host = origin) {
  await page.goto(`${host}/login`);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(credentials[who].email);
  await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(credentials[who].password);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function write(page: Page, path: string, body: object) {
  return page.evaluate(async ({ path, body }) => {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
    const token = document.cookie.split("; ").find(part => part.startsWith("XSRF-TOKEN="))?.split("=")[1];
    const response = await fetch(`/api/v1/center/${path}`, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-XSRF-TOKEN": decodeURIComponent(token ?? "") },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, { path, body });
}

test("copy curriculum with preview, independent target, source history, isolation, and SSR budget", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await browser.newPage();
  const beta = await browser.newPage();
  try {
    await signIn(owner, "alpha");
    const workspace = await (await owner.request.get(`${origin}/api/v1/center/curriculum-workspace`)).json();
    const sourceBranch = workspace.branches.find((branch: { slug: string }) => branch.slug === "north") as { id: number; name: string };
    const targetBranch = workspace.branches.find((branch: { slug: string }) => branch.slug === "south") as { id: number; name: string };
    const north = sourceBranch.id;
    const south = targetBranch.id;
    const name = `نسخة منهج ${Date.now()}`;
    const course = await write(owner, "courses", { branch_id: north, name, request_id: crypto.randomUUID() });
    expect(course.status).toBe(201);
    const stage = await write(owner, `courses/${course.body.course.id}/stages`, { name: "مرحلة المصدر", request_id: crypto.randomUUID() });
    expect(stage.status).toBe(201);
    const level = await write(owner, `stages/${stage.body.stage.id}/levels`, {
      name: "مستوى المصدر", request_id: crypto.randomUUID(),
      lectures: [{ number: 1, content: "محتوى أصلي", planned_hours: 1 }],
    });
    expect(level.status).toBe(201);
    const plan = await write(owner, `levels/${level.body.level.id}/plan-versions`, {
      base_plan_version_id: level.body.level.plan.id, base_revision: 1,
      lectures: [{ number: 1, content: "نسخة ثانية", planned_hours: 2 }], request_id: crypto.randomUUID(),
    });
    expect(plan.status).toBe(201);

    let pageNumber = 1;
    while (true) {
      const result = await (await owner.request.get(`${origin}/api/v1/center/curriculum-workspace?courses_page=${pageNumber}`)).json();
      if (result.courses.some((item: { id: string }) => item.id === course.body.course.id)) break;
      expect(result.pagination.courses.has_more).toBe(true);
      pageNumber++;
    }
    const log = process.env.COURSES_COPY_QUERY_LOG!;
    const before = readFileSync(log, "utf8").trim().split("\n").length;
    await owner.goto(`${origin}/admin/curriculum?courses_page=${pageNumber}`);
    const reads = readFileSync(log, "utf8").trim().split("\n").slice(before)
      .map(line => JSON.parse(line) as { path: string; count: number | null })
      .filter(row => row.path.startsWith("/api/v1/center/curriculum-workspace"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(row => Number.isInteger(row.count) && row.count! <= 6)).toBe(true);
    await owner.getByRole("searchbox", { name: "بحث في الكورسات" }).fill(name);
    const row = owner.getByRole("row").filter({ has: owner.getByRole("heading", { name, exact: true }) })
      .filter({ has: owner.getByRole("cell", { name: sourceBranch.name, exact: true }) });
    await row.getByRole("button", { name: "نسخ المنهج إلى فرع" }).click();
    await expect(owner.getByRole("heading", { name: `نسخ منهج ${name}` })).toBeFocused();
    await owner.getByLabel("الفرع الوجهة").selectOption(String(south));
    const beforePreview = readFileSync(log, "utf8").trim().split("\n").length;
    await owner.getByRole("button", { name: "معاينة ما سيُنسخ" }).click();
    await expect(owner.getByText("١ مرحلة · ١ مستوى · ٢ إصدار خطة · ٢ محاضرة مخططة")).toBeVisible();
    const previewReads = readFileSync(log, "utf8").trim().split("\n").slice(beforePreview)
      .map(line => JSON.parse(line) as { path: string; count: number | null })
      .filter(entry => entry.path.includes(`/courses/${course.body.course.id}/copy-preview`));
    expect(previewReads.length).toBeGreaterThan(0);
    expect(previewReads.every(entry => Number.isInteger(entry.count) && entry.count! <= 6)).toBe(true);
    await expect(owner.getByText("مستوى: مستوى المصدر", { exact: false })).toBeVisible();
    const responsePromise = owner.waitForResponse(response => /\/api\/v1\/center\/courses\/[^/]+\/copies$/.test(response.url()) && response.request().method() === "POST");
    await owner.getByRole("button", { name: "تأكيد النسخ" }).click();
    const copyResponse = await responsePromise;
    expect(copyResponse.status()).toBe(201);
    await expect(owner.getByText(`نُسخ كورس ${name} إلى`, { exact: false })).toBeVisible();
    let copiedId = "";
    for (let page = 1; page <= 10 && !copiedId; page++) {
      const target = await (await owner.request.get(`${origin}/api/v1/center/curriculum-workspace?courses_page=${page}`)).json();
      copiedId = target.courses.find((item: { id: string; branch_id: number; source_course_id: string }) =>
        item.branch_id === south && item.source_course_id === course.body.course.id)?.id ?? "";
      if (!target.pagination.courses.has_more) break;
    }
    expect(copiedId).not.toBe("");
    await owner.getByRole("button", { name: "العودة إلى الكورسات" }).click();
    await row.getByRole("button", { name: "نسخ المنهج إلى فرع" }).click();
    await owner.getByLabel("الفرع الوجهة").selectOption(String(south));
    await owner.getByRole("button", { name: "معاينة ما سيُنسخ" }).click();
    await expect(owner.getByRole("button", { name: "تأكيد النسخ" })).toBeEnabled();
    await owner.route(`**/api/v1/center/courses/${course.body.course.id}/copies`, async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("connectionclosed");
    }, { times: 1 });
    await owner.getByRole("button", { name: "تأكيد النسخ" }).click();
    await expect(owner.getByText("تعذر تأكيد نتيجة النسخ", { exact: false })).toBeVisible();
    await owner.reload();
    await owner.getByRole("searchbox", { name: "بحث في الكورسات" }).fill(name);
    await row.getByRole("button", { name: "نسخ المنهج إلى فرع" }).click();
    await owner.getByLabel("الفرع الوجهة").selectOption(String(south));
    await owner.getByRole("button", { name: "معاينة ما سيُنسخ" }).click();
    await expect(owner.getByText(`تأكدنا من نسخ كورس ${name} إلى`, { exact: false })).toBeVisible();
    let copies = 0;
    for (let page = 1; page <= 10; page++) {
      const target = await (await owner.request.get(`${origin}/api/v1/center/curriculum-workspace?courses_page=${page}`)).json();
      copies += target.courses.filter((item: { branch_id: number; source_course_id: string }) =>
        item.branch_id === south && item.source_course_id === course.body.course.id).length;
      if (!target.pagination.courses.has_more) break;
    }
    expect(copies).toBe(2);
    await owner.goto(`${origin}/admin/audit`);
    await owner.getByText("عرض مصدر نسخة المنهج").first().click();
    await expect(owner.getByText(`المصدر: ${name} · ${sourceBranch.name}`).first()).toBeVisible();
    await expect(owner.locator("html")).toHaveAttribute("dir", "rtl");
    await owner.getByRole("button", { name: "تفعيل الوضع الداكن" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "dark");
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    const betaOrigin = origin.replace("alpha.", "beta.");
    await signIn(beta, "beta", betaOrigin);
    expect((await beta.request.get(`${betaOrigin}/api/v1/center/courses/${course.body.course.id}/copy-preview?target_branch_id=${south}`)).status()).toBe(404);
  } finally { await owner.close(); await beta.close(); }
});

import { finishWorkspaceEntry, expectWorkspaceUrl } from "./workspace-testhelpers";
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(
  !process.env.COURSES_PHOTO_CREDENTIALS,
  "Requires the disposable student-photo PostgreSQL fixture.",
);
const origin =
  process.env.COURSES_PHOTO_ORIGIN ?? "http://alpha.courses.test:8057";
const credentials = process.env.COURSES_PHOTO_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_PHOTO_CREDENTIALS, "utf8"))
  : {};
const photo = {
  name: "student.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAHUlEQVQ4jWMUSbFhIBcwka1zVPOo5lHNo5qpohkAvIEA3Cu5xEYAAAAASUVORK5CYII=",
    "base64",
  ),
};
async function signIn(page: Page, who = "alpha") {
  await page.goto(
    `${who === "beta" ? origin.replace("alpha.", "beta.") : origin}/login`,
  );
  await page
    .getByRole("textbox", { name: "البريد الإلكتروني" })
    .pressSequentially(credentials[who].email);
  await page
    .getByRole("textbox", { name: "كلمة المرور", exact: true })
    .pressSequentially(credentials[who].password);
  await page.getByRole("button", { name: "دخول المركز", exact: true }).click();
  await finishWorkspaceEntry(page);
  await expectWorkspaceUrl(page, "/admin");
}
async function write(
  page: Page,
  route: string,
  method: string,
  payload: object,
) {
  return page.evaluate(
    async ({ route, method, payload }) => {
      await fetch("/sanctum/csrf-cookie", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const token = document.cookie
        .split("; ")
        .find((part) => part.startsWith("XSRF-TOKEN="))
        ?.split("=")[1];
      const response = await fetch(`/api/v1/center/${route}`, {
        method,
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-XSRF-TOKEN": decodeURIComponent(token ?? ""),
        },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    },
    { route, method, payload },
  );
}

test("upload and replace the profile photo from its own header form and preserve general profile data", async ({
  page,
}) => {
  await signIn(page);
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  const student = (
    await write(page, "students", "POST", {
      name: `PHOTO64 ${Date.now()}`,
      branch_ids: [workspace.branches[0].id],
      request_id: crypto.randomUUID(),
      employer: "بيانات باقية",
      passport_number: "PHOTO64-PRIVATE-PASSPORT",
    })
  ).body.student;
  await page.goto(`${origin}/admin/students/${student.id}`);
  await page
    .getByLabel("اختيار صورة الطالب", { exact: true })
    .setInputFiles(photo);
  await page
    .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "حُفظت صورة الطالب" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: `صورة ${student.name}`, exact: true }),
  ).toBeVisible();
  const before = (
    await (
      await page.request.get(`${origin}/api/v1/center/students/${student.id}`)
    ).json()
  ).students[0];
  await page
    .getByLabel("اختيار صورة الطالب", { exact: true })
    .setInputFiles(photo);
  await page
    .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              `${origin}/api/v1/center/students/${student.id}`,
            )
          ).json()
        ).students[0].photo_revision,
    )
    .toBe(3);
  const current = (
    await (
      await page.request.get(`${origin}/api/v1/center/students/${student.id}`)
    ).json()
  ).students[0];
  expect(current.photo.id).not.toBe(before.photo.id);
  expect(current.employer).toBe("بيانات باقية");
  expect(current.identity.passport_number).toBe("PHOTO64-PRIVATE-PASSPORT");
  expect(current.revision).toBe(1);
});

async function upload(
  page: Page,
  studentId: string,
  revision: number,
  requestId = crypto.randomUUID(),
) {
  return page.evaluate(
    async ({ studentId, revision, requestId, bytes }) => {
      await fetch("/sanctum/csrf-cookie", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const token = document.cookie
        .split("; ")
        .find((item) => item.startsWith("XSRF-TOKEN="))
        ?.split("=")[1];
      const body = new FormData();
      body.set(
        "photo",
        new File(
          [Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))],
          "student.png",
          { type: "image/png" },
        ),
      );
      body.set("request_id", requestId);
      body.set("photo_revision", String(revision));
      const response = await fetch(
        `/api/v1/center/students/${studentId}/photo`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "X-XSRF-TOKEN": decodeURIComponent(token ?? ""),
          },
          body,
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { studentId, revision, requestId, bytes: photo.buffer.toString("base64") },
  );
}
async function createStudent(page: Page, branchId: number) {
  const result = await write(page, "students", "POST", {
    name: `PHOTO64 ${Date.now()} ${crypto.randomUUID().slice(0, 4)}`,
    branch_ids: [branchId],
    request_id: crypto.randomUUID(),
  });
  expect(result.status).toBe(201);
  return result.body.student;
}

test("stale image forms retain the selection, recover in the header and enforce revoked branch authority and foreign centers", async ({
  browser,
}) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  const beta = await browser.newPage();
  let member:
    | {
        id: number;
        center_roles: string[];
        branch_roles: Record<string, string[]>;
      }
    | undefined;
  try {
    await signIn(owner);
    await signIn(staff, "staff");
    await signIn(beta, "beta");
    const workspace = await (
      await owner.request.get(`${origin}/api/v1/center/student-workspace`)
    ).json();
    const student = await createStudent(owner, workspace.branches[0].id);
    await owner.goto(`${origin}/admin/students/${student.id}`);
    await owner
      .getByLabel("اختيار صورة الطالب", { exact: true })
      .setInputFiles(photo);
    const raced = await Promise.all([
      upload(owner, student.id, 1),
      upload(owner, student.id, 1),
    ]);
    expect(raced.map((item) => item.status).sort()).toEqual([201, 409]);
    await owner
      .getByRole("button", { name: "تغيير مشاركة الطالب", exact: true })
      .click();
    await owner
      .getByRole("alertdialog")
      .getByRole("button", {
        name: student.sharing_enabled
          ? "غلق مشاركة الطالب"
          : "السماح بمشاركة الطالب",
        exact: true,
      })
      .click();
    await expect(
      owner.getByRole("img", { name: `صورة ${student.name}`, exact: true }),
    ).toBeVisible();
    const stale = owner.waitForResponse(
      (response) =>
        response.url().endsWith(`/students/${student.id}/photo`) &&
        response.request().method() === "POST",
    );
    await owner
      .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
      .click();
    expect((await stale).status()).toBe(409);
    await expect(
      owner.getByLabel("اختيار صورة الطالب", { exact: true }),
    ).toHaveValue(/student\.png$/);
    await expect(
      owner.getByRole("button", { name: "حفظ صورة الطالب", exact: true }),
    ).toBeDisabled();
    await owner
      .getByRole("button", { name: "تحميل أحدث صورة الطالب", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "حفظ صورة الطالب", exact: true }),
    ).toBeEnabled();
    await owner
      .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
      .click();
    await expect(
      owner.getByRole("status").filter({ hasText: "حُفظت صورة الطالب" }),
    ).toBeVisible();
    const current = (
      await (
        await owner.request.get(
          `${origin}/api/v1/center/students/${student.id}`,
        )
      ).json()
    ).students[0];
    expect(current.photo_revision).toBe(3);
    const members = (
      await (
        await owner.request.get(`${origin}/api/v1/center/member-workspace`)
      ).json()
    ).members;
    member = members.find(
      (item: { user: { email: string } }) =>
        item.user.email === credentials.staff.email,
    );
    if (!member) throw new Error("Staff membership is missing");
    expect(
      (
        await write(owner, `members/${member.id}/grants`, "PUT", {
          center_roles: [],
          branch_roles: { [workspace.branches[0].id]: ["registration"] },
        })
      ).status,
    ).toBe(200);
    await staff.goto(`${origin}/admin/students/${student.id}`);
    await staff
      .getByLabel("اختيار صورة الطالب", { exact: true })
      .setInputFiles(photo);
    expect(
      (
        await write(owner, `members/${member.id}/grants`, "PUT", {
          center_roles: [],
          branch_roles: { [workspace.branches[0].id]: ["branch_viewer"] },
        })
      ).status,
    ).toBe(200);
    const denied = staff.waitForResponse(
      (response) =>
        response.url().endsWith(`/students/${student.id}/photo`) &&
        response.request().method() === "POST",
    );
    await staff
      .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
      .click();
    expect((await denied).status()).toBe(404);
    await expect(
      staff.getByLabel("اختيار صورة الطالب", { exact: true }),
    ).toHaveValue(/student\.png$/);
    await staff
      .getByRole("button", { name: "إلغاء اختيار الصورة", exact: true })
      .click();
    await staff.goto(`${origin}/admin/students/${student.id}`);
    await expect(
      staff.getByRole("img", { name: `صورة ${student.name}`, exact: true }),
    ).toBeVisible();
    await expect(
      staff.getByLabel("اختيار صورة الطالب", { exact: true }),
    ).toHaveCount(0);
    expect(
      (await staff.request.get(`${origin}${current.photo.url}`)).status(),
    ).toBe(200);
    expect(
      (
        await write(owner, `members/${member.id}/grants`, "PUT", {
          center_roles: [],
          branch_roles: {
            [workspace.branches[1].id]: ["registration", "student_identity"],
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (await staff.request.get(`${origin}${current.photo.url}`)).status(),
    ).toBe(404);
    const betaOrigin = origin.replace("alpha.", "beta.");
    expect(
      (await beta.request.get(`${betaOrigin}${current.photo.url}`)).status(),
    ).toBe(404);
    expect(
      (
        await beta.request.get(
          `${betaOrigin}/api/v1/center/students/${student.id}`,
        )
      ).status(),
    ).toBe(404);
    const betaWorkspace = await (
      await beta.request.get(`${betaOrigin}/api/v1/center/student-workspace`)
    ).json();
    const betaStudent = await createStudent(beta, betaWorkspace.branches[0].id);
    expect(
      (await upload(beta, betaStudent.id, 1, current.photo.id)).status,
    ).toBe(201);
    expect(
      (
        await owner.request.get(
          `${origin}/api/v1/center/students/${betaStudent.id}/photo/${current.photo.id}`,
        )
      ).status(),
    ).toBe(404);
    expect(
      (await owner.request.get(`${origin}${current.photo.url}`)).status(),
    ).toBe(200);
  } finally {
    if (member)
      await write(owner, `members/${member.id}/grants`, "PUT", {
        center_roles: member.center_roles,
        branch_roles: member.branch_roles,
      });
    await owner.close();
    await staff.close();
    await beta.close();
  }
});

test("an interrupted response keeps the selected file and retries the committed upload without a duplicate event", async ({
  page,
}) => {
  await signIn(page);
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  const student = await createStudent(page, workspace.branches[0].id);
  await page.goto(`${origin}/admin/students/${student.id}`);
  await page
    .getByLabel("اختيار صورة الطالب", { exact: true })
    .setInputFiles(photo);
  const endpoint = `**/api/v1/center/students/${student.id}/photo`;
  await page.route(endpoint, async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
    .click();
  await expect(
    page.getByText(
      "تعذر التأكد من حفظ الصورة. الملف المختار محفوظ؛ أعد المحاولة بنفس الطلب أو حمّل أحدث الصورة.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("اختيار صورة الطالب", { exact: true }),
  ).toHaveValue(/student\.png$/);
  expect(
    (
      await (
        await page.request.get(`${origin}/api/v1/center/students/${student.id}`)
      ).json()
    ).students[0].photo_revision,
  ).toBe(2);
  await page.unroute(endpoint);
  await page
    .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "حُفظت صورة الطالب" }),
  ).toBeVisible();
  expect(
    (
      await (
        await page.request.get(`${origin}/api/v1/center/students/${student.id}`)
      ).json()
    ).students[0].photo_revision,
  ).toBe(2);
  const entries = (
    await (await page.request.get(`${origin}/api/v1/center/audit`)).json()
  ).entries;
  expect(
    entries.filter(
      (entry: { event: string; details: string }) =>
        entry.event === "student.photo_changed" &&
        JSON.parse(entry.details).student_id === student.id,
    ),
  ).toHaveLength(1);
});

test("photo summaries render through SSR within six reads and remain usable in mobile RTL themes, validation and cancellation", async ({
  page,
  browser,
}) => {
  test.skip(
    !process.env.COURSES_PHOTO_READ_LOG,
    "Requires SSR-aware read meter",
  );
  await signIn(page);
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  const student = await createStudent(page, workspace.branches[0].id);
  expect((await upload(page, student.id, 1)).status).toBe(201);
  const log = process.env.COURSES_PHOTO_READ_LOG!;
  const lines = () =>
    readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  for (const route of [
    `/admin/students/${student.id}`,
    `/admin/students/${student.id}?tab=custom-history`,
    `/admin/students/${student.id}/edit`,
  ]) {
    const start = lines().length;
    await page.goto(`${origin}${route}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (!route.endsWith("/edit"))
      await expect(
        page.getByRole("img", { name: `صورة ${student.name}`, exact: true }),
      ).toBeVisible();
    const rows = lines()
      .slice(start)
      .map((line) => JSON.parse(line))
      .filter(
        (row) =>
          row.host?.startsWith("alpha.") &&
          row.path?.startsWith("/api/v1/center/"),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (row) =>
          typeof row.count === "number" &&
          row.count > 0 &&
          typeof row.ms === "number" &&
          row.ms >= 0,
      ),
    ).toBe(true);
    const sql = rows.reduce((sum, row) => sum + row.count, 0);
    console.log(
      JSON.stringify({
        route,
        sql,
        sql_ms: rows.reduce((sum, row) => sum + row.ms, 0),
      }),
    );
    expect(sql).toBeLessThanOrEqual(6);
  }
  const noJs = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await page.context().storageState(),
  });
  try {
    const view = await noJs.newPage();
    await view.goto(`${origin}/admin/students/${student.id}`);
    await expect(
      view.getByRole("img", { name: `صورة ${student.name}`, exact: true }),
    ).toBeVisible();
  } finally {
    await noJs.close();
  }
  await page.goto(`${origin}/admin/students/${student.id}`);
  await page
    .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
    .click();
  await expect(
    page.getByLabel("اختيار صورة الطالب", { exact: true }),
  ).toBeFocused();
  await page.getByLabel("اختيار صورة الطالب", { exact: true }).setInputFiles({
    name: "forged.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await page
    .getByRole("button", { name: "حفظ صورة الطالب", exact: true })
    .click();
  await expect(
    page.getByLabel("اختيار صورة الطالب", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("img", { name: `صورة ${student.name}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "إلغاء اختيار الصورة", exact: true })
    .click();
  await expect(
    page.getByLabel("اختيار صورة الطالب", { exact: true }),
  ).toBeFocused();
  await page
    .getByLabel("اختيار صورة الطالب", { exact: true })
    .setInputFiles(photo);
  await page
    .getByRole("link", { name: "العودة إلى ملفات الطلاب", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "إلغاء", exact: true })
    .click();
  await expect(
    page.getByLabel("اختيار صورة الطالب", { exact: true }),
  ).toHaveValue(/student\.png$/);
  await page
    .getByRole("button", { name: "إلغاء اختيار الصورة", exact: true })
    .click();
  for (const [width, theme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
    [390, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page
      .context()
      .addCookies([{ name: "courses_theme", value: theme, url: origin }]);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const input = page.getByLabel("اختيار صورة الطالب", { exact: true });
    const save = page.getByRole("button", {
      name: "حفظ صورة الطالب",
      exact: true,
    });
    await save.focus();
    await expect(save).toBeFocused();
    await expect(save).toHaveAttribute(
      "form",
      await input.evaluate((element) => (element as HTMLInputElement).form!.id),
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `/tmp/courses-issue57/photo-${width}-${theme}.png`,
      fullPage: false,
    });
  }
  await page.evaluate(() =>
    document
      .querySelector("header")
      ?.setAttribute("data-photo-frame", "stable"),
  );
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document")
      documents.push(request.url());
  });
  const history = page.getByRole("link", {
    name: "تاريخ الحقول الإضافية",
    exact: true,
  });
  await history.hover();
  await history.click();
  await expect(page).toHaveURL(/tab=custom-history$/);
  expect(documents).toHaveLength(0);
  await expect(page.locator("header")).toHaveAttribute(
    "data-photo-frame",
    "stable",
  );
});

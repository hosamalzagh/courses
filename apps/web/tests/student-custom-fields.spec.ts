import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(
  !process.env.COURSES_CUSTOM_CREDENTIALS,
  "Requires the disposable student-custom-fields PostgreSQL fixture.",
);
const origin =
  process.env.COURSES_CUSTOM_ORIGIN ?? "http://alpha.courses.test:8057";
const credentials = process.env.COURSES_CUSTOM_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_CUSTOM_CREDENTIALS, "utf8"))
  : {};
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
  await expect(page).toHaveURL(/\/admin$/);
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
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

test.beforeEach(async ({ page }) => {
  await signIn(page);
  for (let pageNumber = 1; ; pageNumber++) {
    const response = await page.request.get(
      `${origin}/api/v1/center/student-custom-fields?manage=1&page=${pageNumber}`,
    );
    expect(response.status()).toBe(200);
    const data = await response.json();
    for (const field of data.fields.filter(
      (field: { label: string; required: boolean }) =>
        field.required && /^(?:skillcard \d+|CUSTOM62)/.test(field.label),
    )) {
      expect(
        (
          await write(page, `student-custom-fields/${field.id}`, "PATCH", {
            label: field.label,
            position: field.position,
            required: false,
            revision: field.revision,
          })
        ).status,
      ).toBe(200);
    }
    if (!data.pagination.has_more) break;
  }
});

test("manager defines a required skillcard and registration form preserves input on missing custom values", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${origin}/admin/student-custom-fields`);
  await page.getByRole("button", { name: "إضافة حقل", exact: true }).click();
  const label = `skillcard ${Date.now()}`;
  await page
    .getByRole("textbox", { name: "اسم الحقل", exact: true })
    .fill(label);
  await page.getByRole("checkbox", { name: "حقل مطلوب", exact: true }).check();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/student-custom-fields") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "حفظ الحقل", exact: true }).click();
  const field = (await (await created).json()).field;
  await expect(
    page.getByRole("cell", { name: label, exact: true }),
  ).toBeVisible();
  await page.goto(`${origin}/admin/students/new`);
  const name = `طالب حقول عامة ${Date.now()}`;
  await page
    .getByRole("textbox", { name: "اسم الطالب", exact: true })
    .fill(name);
  await page
    .getByRole("textbox", { name: "المدرسة / جهة الدراسة", exact: true })
    .fill("مدرسة محفوظة");
  await page
    .getByRole("button", { name: "حفظ ملف الطالب", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: label, exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "اسم الطالب", exact: true }),
  ).toHaveValue(name);
  await page
    .getByRole("textbox", { name: label, exact: true })
    .fill("000SKILL");
  await page
    .getByRole("button", { name: "حفظ ملف الطالب", exact: true })
    .click();
  await expect(page).toHaveURL(/\/students\/[0-9a-f-]+\?focus=edit$/);
  await expect(page.getByText("000SKILL", { exact: true })).toBeVisible();
  expect(
    (
      await write(page, `student-custom-fields/${field.id}`, "PATCH", {
        label: field.label,
        position: field.position,
        required: false,
        revision: field.revision,
      })
    ).status,
  ).toBe(200);
});

test("progressive fields keep existing values and reading the next page does not create unsaved edits", async ({
  page,
}) => {
  const stamp = Date.now();
  let last: { id: string; label: string };
  for (let index = 0; index < 56; index++) {
    const result = await write(page, "student-custom-fields", "POST", {
      id: crypto.randomUUID(),
      label: `CUSTOM62 page ${stamp} ${index}`,
      type: "text",
      required: false,
      position: 1000 + index,
      options: [],
    });
    expect(result.status).toBe(201);
    last = result.body.field;
  }
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  expect(workspace.custom_fields.fields.length).toBe(50);
  expect(workspace.custom_fields.has_more).toBe(true);
  const result = await write(page, "students", "POST", {
    name: `CUSTOM62 paging ${stamp}`,
    branch_ids: [workspace.branches[0].id],
    request_id: crypto.randomUUID(),
    custom_fields_revision: workspace.custom_fields.revision,
    custom_values: { [last!.id]: "PRESERVED56" },
  });
  expect(result.status).toBe(201);
  const student = result.body.student;
  await page.goto(`${origin}/admin/students/${student.id}/edit`);
  while (
    !(await page
      .getByRole("textbox", { name: last!.label, exact: true })
      .count())
  ) {
    const before = await page.getByRole("textbox").count();
    await page
      .getByRole("button", { name: "تحميل المزيد من الحقول", exact: true })
      .click();
    await expect
      .poll(() => page.getByRole("textbox").count())
      .toBeGreaterThan(before);
  }
  await expect(
    page.getByRole("textbox", { name: last!.label, exact: true }),
  ).toHaveValue("PRESERVED56");
  await page
    .locator(".center-topbar")
    .getByRole("link", { name: "إلغاء", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/students/${student.id}\\?focus=edit$`),
  );
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  while (!(await page.getByText("PRESERVED56", { exact: true }).count())) {
    const before = await page.locator("dt").count();
    await page
      .getByRole("button", { name: "تحميل المزيد من الحقول", exact: true })
      .click();
    await expect.poll(() => page.locator("dt").count()).toBeGreaterThan(before);
  }
  await expect(page.getByText("PRESERVED56", { exact: true })).toBeVisible();
});

test("all custom types validate in the real form, old missing fields warn, and independent sharing and status stay usable", async ({
  page,
}) => {
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  const old = await write(page, "students", "POST", {
    name: `CUSTOM62 old ${Date.now()}`,
    branch_ids: [workspace.branches[0].id],
    request_id: crypto.randomUUID(),
  });
  expect(old.status).toBe(201);
  const fields: {
    id: string;
    label: string;
    type: string;
    position: number;
    revision: number;
  }[] = [];
  const stamp = Date.now();
  try {
    for (const [index, type] of [
      "text",
      "number",
      "date",
      "select",
      "boolean",
    ].entries()) {
      await page.goto(`${origin}/admin/student-custom-fields`);
      await page
        .getByRole("button", { name: "إضافة حقل", exact: true })
        .click();
      const label = `CUSTOM62 typed ${stamp} ${type}`;
      await page
        .getByRole("textbox", { name: "اسم الحقل", exact: true })
        .fill(label);
      await select(
        page,
        "نوع الحقل",
        {
          text: "نص",
          number: "رقم",
          date: "تاريخ",
          select: "قائمة اختيارات",
          boolean: "نعم / لا",
        }[type]!,
      );
      if (type === "select")
        await page
          .getByRole("textbox", { name: "اختيارات القائمة", exact: true })
          .fill("اختيار أ | اختيار ب");
      await page
        .getByRole("textbox", { name: "الترتيب", exact: true })
        .fill(String(index));
      await page
        .getByRole("checkbox", { name: "حقل مطلوب", exact: true })
        .check();
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith("/student-custom-fields") &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "حفظ الحقل", exact: true })
        .click();
      fields.push((await (await response).json()).field);
      await page
        .getByRole("searchbox", { name: "بحث في حقول المركز", exact: true })
        .fill(label);
      await expect(
        page.getByRole("cell", { name: label, exact: true }),
      ).toBeVisible();
    }
    await page.goto(`${origin}/admin/students/${old.body.student.id}`);
    await expect(page.getByText(/الملف ينقصه/)).toBeVisible();
    const sharing = await write(
      page,
      `students/${old.body.student.id}/sharing`,
      "PATCH",
      { revision: 1, sharing_enabled: !old.body.student.sharing_enabled },
    );
    expect(sharing.status).toBe(200);
    const suspension = await write(
      page,
      `students/${old.body.student.id}/status`,
      "POST",
      {
        status: "suspended",
        reason: "إجراء مستقل عن النواقص",
        status_revision: 1,
        request_id: crypto.randomUUID(),
      },
    );
    expect(suspension.status).toBe(200);
    await page.goto(`${origin}/admin/students/new`);
    const name = `CUSTOM62 typed student ${stamp}`;
    await page
      .getByRole("textbox", { name: "اسم الطالب", exact: true })
      .fill(name);
    await page
      .getByRole("textbox", { name: "رقم جواز السفر", exact: true })
      .fill("000CUSTOM-INTEGRATION");
    await page
      .getByRole("textbox", { name: fields[0].label, exact: true })
      .fill("000CARD");
    await page
      .getByRole("textbox", { name: fields[1].label, exact: true })
      .fill("0");
    await page
      .getByRole("textbox", { name: fields[2].label, exact: true })
      .fill("2001-02-29");
    await select(page, `${fields[3].label} (مطلوب)`, "اختيار ب");
    await select(page, `${fields[4].label} (مطلوب)`, "لا");
    const invalid = page.waitForResponse(
      (response) =>
        response.url().endsWith("/students") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "حفظ ملف الطالب", exact: true })
      .click();
    expect((await invalid).status()).toBe(422);
    await expect(
      page.getByRole("textbox", { name: fields[2].label, exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("textbox", { name: "اسم الطالب", exact: true }),
    ).toHaveValue(name);
    await page
      .getByRole("textbox", { name: fields[2].label, exact: true })
      .fill("2000-02-29");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/students") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "حفظ ملف الطالب", exact: true })
      .click();
    const student = (await (await saved).json()).student;
    await expect(page.getByText("000CARD", { exact: true })).toBeVisible();
    expect(student.custom_values[fields[4].id]).toBe(false);
    expect(student.custom_values[fields[1].id]).toBe("0");
    expect(student.identity.passport_number).toBe("000CUSTOM-INTEGRATION");
    await page
      .getByRole("link", { name: "تعديل ملف الطالب", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: fields[0].label, exact: true })
      .fill("000CARD2");
    await page
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    await expect(page.getByText("000CARD2", { exact: true })).toBeVisible();
  } finally {
    for (const field of fields) {
      const latest = (
        await (
          await page.request.get(
            `${origin}/api/v1/center/student-custom-fields/${field.id}`,
          )
        ).json()
      ).field;
      expect(
        (
          await write(page, `student-custom-fields/${field.id}`, "PATCH", {
            label: latest.label,
            position: latest.position,
            required: false,
            revision: latest.revision,
          })
        ).status,
      ).toBe(200);
    }
  }
});

test("definition and profile conflicts keep drafts, owner revocation blocks the next open-editor request, and writes serialize", async ({
  page,
  browser,
}) => {
  const stamp = Date.now();
  const payload = {
    id: crypto.randomUUID(),
    label: `CUSTOM62 conflict ${stamp}`,
    type: "text",
    required: false,
    position: 0,
    options: [],
  };
  const creates = await Promise.all([
    write(page, "student-custom-fields", "POST", payload),
    write(page, "student-custom-fields", "POST", payload),
  ]);
  expect(creates.map((row) => row.status).sort()).toEqual([200, 201]);
  let field = creates[0].body.field;
  const updates = await Promise.all(
    ["أ", "ب"].map((suffix) =>
      write(page, `student-custom-fields/${field.id}`, "PATCH", {
        label: `${payload.label} ${suffix}`,
        required: false,
        position: 0,
        revision: field.revision,
      }),
    ),
  );
  expect(updates.map((row) => row.status).sort()).toEqual([200, 409]);
  field = updates.find((row) => row.status === 200)!.body.field;
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  const result = await write(page, "students", "POST", {
    name: `CUSTOM62 conflict student ${stamp}`,
    branch_ids: [workspace.branches[0].id],
    request_id: crypto.randomUUID(),
    custom_values: { [field.id]: "ORIGINAL-CUSTOM" },
  });
  expect(result.status).toBe(201);
  let student = result.body.student;
  const race = await Promise.all(
    ["ONE", "TWO"].map((value) =>
      write(page, `students/${student.id}`, "PATCH", {
        name: student.name,
        branch_ids: [],
        revision: student.revision,
        custom_values: { [field.id]: value },
      }),
    ),
  );
  expect(race.map((row) => row.status).sort()).toEqual([200, 409]);
  student = race.find((row) => row.status === 200)!.body.student;
  await page.goto(`${origin}/admin/students/${student.id}/edit`);
  await page
    .getByRole("textbox", { name: field.label, exact: true })
    .fill("DRAFT-CUSTOM");
  await page
    .getByRole("textbox", { name: "اسم الطالب", exact: true })
    .fill(`CUSTOM62 retained ${stamp}`);
  const newField = await write(page, "student-custom-fields", "POST", {
    id: crypto.randomUUID(),
    label: `CUSTOM62 required ${stamp}`,
    type: "text",
    required: true,
    position: 0,
    options: [],
  });
  expect(newField.status).toBe(201);
  try {
    const conflict = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/students/${student.id}`) &&
        response.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    expect((await conflict).status()).toBe(409);
    await expect(
      page.getByRole("textbox", { name: field.label, exact: true }),
    ).toHaveValue("DRAFT-CUSTOM");
    await expect(
      page.getByRole("textbox", { name: "اسم الطالب", exact: true }),
    ).toHaveValue(`CUSTOM62 retained ${stamp}`);
    await page
      .getByRole("button", {
        name: "تحميل تعريفات الحقول الحالية",
        exact: true,
      })
      .click();
    await page
      .getByRole("textbox", { name: newField.body.field.label, exact: true })
      .fill("NEW-REQUIRED");
    await expect(
      page.getByRole("textbox", { name: field.label, exact: true }),
    ).toHaveValue("DRAFT-CUSTOM");
    await page
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/students/${student.id}\\?focus=edit$`),
    );
    await expect(page.getByText("DRAFT-CUSTOM", { exact: true })).toBeVisible();
  } finally {
    const latest = (
      await (
        await page.request.get(
          `${origin}/api/v1/center/student-custom-fields/${newField.body.field.id}`,
        )
      ).json()
    ).field;
    await write(page, `student-custom-fields/${latest.id}`, "PATCH", {
      label: latest.label,
      required: false,
      position: latest.position,
      revision: latest.revision,
    });
  }
  const staff = await browser.newPage();
  let member:
    | {
        id: number;
        center_roles: string[];
        branch_roles: Record<string, string[]>;
      }
    | undefined;
  try {
    const members = await (
      await page.request.get(`${origin}/api/v1/center/member-workspace`)
    ).json();
    member = members.members.find(
      (row: { user: { email: string } }) =>
        row.user.email === credentials.staff.email,
    );
    const north = members.branches.find(
      (row: { slug: string }) => row.slug === "north",
    );
    expect(
      (
        await write(page, `members/${member!.id}/grants`, "PUT", {
          center_roles: [],
          branch_roles: { [north.id]: ["registration"] },
        })
      ).status,
    ).toBe(200);
    await signIn(staff, "staff");
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    await staff
      .getByRole("textbox", { name: field.label, exact: true })
      .fill("DENIED-DRAFT");
    expect(
      (
        await write(staff, "student-custom-fields", "POST", {
          ...payload,
          id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await write(page, `members/${member!.id}/grants`, "PUT", {
          center_roles: [],
          branch_roles: { [north.id]: ["branch_viewer"] },
        })
      ).status,
    ).toBe(200);
    const denied = staff.waitForResponse(
      (response) =>
        response.url().endsWith(`/students/${student.id}`) &&
        response.request().method() === "PATCH",
    );
    await staff
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    expect((await denied).status()).toBe(403);
    await expect(
      staff.getByRole("textbox", { name: field.label, exact: true }),
    ).toHaveValue("DENIED-DRAFT");
    const current = await (
      await page.request.get(`${origin}/api/v1/center/students/${student.id}`)
    ).json();
    expect(current.students[0].custom_values[field.id]).toBe("DRAFT-CUSTOM");
  } finally {
    if (member)
      await write(page, `members/${member.id}/grants`, "PUT", {
        center_roles: member.center_roles,
        branch_roles: member.branch_roles,
      });
    await staff.close();
  }
  await page.goto(`${origin}/admin/student-custom-fields`);
  await page
    .getByRole("searchbox", { name: "بحث في حقول المركز", exact: true })
    .fill(field.label);
  await page
    .getByRole("row")
    .filter({ hasText: field.label })
    .getByRole("button", { name: "تعديل", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "اسم الحقل", exact: true })
    .fill(`CUSTOM62 pending ${stamp}`);
  expect(
    (
      await write(page, `student-custom-fields/${field.id}`, "PATCH", {
        label: `CUSTOM62 latest ${stamp}`,
        required: false,
        position: 0,
        revision: field.revision,
      })
    ).status,
  ).toBe(200);
  await page.getByRole("button", { name: "حفظ الحقل", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "تحميل تعريف الحقل الحالي", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "اسم الحقل", exact: true }),
  ).toHaveValue(`CUSTOM62 pending ${stamp}`);
  await page
    .getByRole("button", { name: "تحميل تعريف الحقل الحالي", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "اسم الحقل", exact: true }),
  ).toHaveValue(`CUSTOM62 latest ${stamp}`);
  await page
    .getByRole("textbox", { name: "اسم الحقل", exact: true })
    .fill(`CUSTOM62 final ${stamp}`);
  await page.getByRole("button", { name: "حفظ الحقل", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "بحث في حقول المركز", exact: true })
    .fill(`CUSTOM62 final ${stamp}`);
  await expect(
    page.getByRole("cell", { name: `CUSTOM62 final ${stamp}`, exact: true }),
  ).toBeVisible();
});

test("custom field editors support cancel, keyboard, mobile RTL themes and shared header forms", async ({
  page,
}) => {
  await page
    .getByRole("link", { name: "الحقول الإضافية للطالب", exact: true })
    .click();
  const opener = page.getByRole("button", { name: "إضافة حقل", exact: true });
  await opener.click();
  const label = page.getByRole("textbox", { name: "اسم الحقل", exact: true });
  await expect(label).toBeFocused();
  await label.fill("CUSTOM62 unsaved");
  const button = page.getByRole("button", { name: "حفظ الحقل", exact: true });
  expect(
    await button.evaluate((button) =>
      Boolean(
        button.closest("header") &&
        (button as HTMLButtonElement).form?.getAttribute("aria-label") ===
          "تعريف حقل إضافي",
      ),
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/courses-issue57/custom-desktop-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "تفعيل الوضع الداكن", exact: true })
    .click();
  await page.screenshot({
    path: "/tmp/courses-issue57/custom-desktop-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/courses-issue57/custom-mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.goBack();
  await expect(page.getByRole("alertdialog")).toContainText("مغادرة دون حفظ");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "إلغاء", exact: true })
    .click();
  await expect(label).toHaveValue("CUSTOM62 unsaved");
  await page
    .locator(".center-topbar")
    .getByRole("button", { name: "إلغاء", exact: true })
    .click();
  await expect(opener).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await opener.click();
  await label.fill("");
  await button.click();
  await expect(label).toBeFocused();
  await expect(label).toHaveAttribute("aria-invalid", "true");
});

test("custom field SSR and warm navigation keep six measured SQL reads and a persistent shell", async ({
  page,
}) => {
  test.skip(!process.env.COURSES_CUSTOM_READ_LOG, "Requires SSR read log.");
  const log = process.env.COURSES_CUSTOM_READ_LOG!;
  const cursor = () =>
    readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  const reads = (start: number) =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(start)
      .map((line) => JSON.parse(line))
      .filter(
        (row) =>
          row.host?.startsWith("alpha.") &&
          row.path?.startsWith("/api/v1/center/"),
      ) as { count: number | null }[];
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  const created = await write(page, "students", "POST", {
    name: `CUSTOM62 SQL ${Date.now()}`,
    branch_ids: [workspace.branches[0].id],
    request_id: crypto.randomUUID(),
  });
  expect(created.status).toBe(201);
  const student = created.body.student;
  for (const route of [
    "/admin/student-custom-fields",
    "/admin/student-custom-fields?page=2",
    "/admin/students",
    "/admin/students/new",
    `/admin/students/${student.id}`,
    `/admin/students/${student.id}/edit`,
  ]) {
    const start = cursor();
    await page.goto(`${origin}${route}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const rows = reads(start);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((row) => typeof row.count === "number" && row.count > 0),
    ).toBe(true);
    const sql = rows.reduce((sum, row) => sum + (row.count ?? Number.NaN), 0);
    console.log(JSON.stringify({ route, sql }));
    expect(sql).toBeLessThanOrEqual(6);
  }
  const start = cursor();
  await page
    .getByRole("button", { name: "تحميل المزيد من الحقول", exact: true })
    .click();
  await expect.poll(() => reads(start).length).toBeGreaterThan(0);
  const rows = reads(start);
  expect(
    rows.every((row) => typeof row.count === "number" && row.count > 0),
  ).toBe(true);
  expect(
    rows.reduce((sum, row) => sum + (row.count ?? Number.NaN), 0),
  ).toBeLessThanOrEqual(6);
  await page
    .locator(".center-topbar")
    .evaluate((element) =>
      element.setAttribute("data-custom-shell", "retained"),
    );
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  const warm = cursor();
  const link = page.getByRole("link", {
    name: "الحقول الإضافية للطالب",
    exact: true,
  });
  await link.hover();
  await expect.poll(() => reads(warm).length).toBeGreaterThan(0);
  await link.click();
  await expect(page).toHaveURL(/\/admin\/student-custom-fields$/);
  await expect(page.locator(".center-topbar")).toHaveAttribute(
    "data-custom-shell",
    "retained",
  );
  expect(documents).toEqual([]);
  expect(
    reads(warm).reduce((sum, row) => sum + (row.count ?? Number.NaN), 0),
  ).toBeLessThanOrEqual(6);
});

test("profile recovery resets paged definitions and restores stored later-page values at the current template revision", async ({
  page,
}) => {
  test.setTimeout(60000);
  const stamp = Date.now();
  const label = `CUSTOM62 recovery ${stamp}`;
  const result = await write(page, "student-custom-fields", "POST", {
    id: crypto.randomUUID(),
    label,
    type: "text",
    required: true,
    position: 1000000,
    options: [],
  });
  expect(result.status).toBe(201);
  const field = result.body.field;
  try {
    const workspace = await (
      await page.request.get(`${origin}/api/v1/center/student-workspace`)
    ).json();
    const created = await write(page, "students", "POST", {
      name: `CUSTOM62 recovery student ${stamp}`,
      branch_ids: [workspace.branches[0].id],
      request_id: crypto.randomUUID(),
      custom_values: { [field.id]: "SAVED-LATER-PAGE" },
    });
    expect(created.status).toBe(201);
    const student = created.body.student;
    await page.goto(`${origin}/admin/students/${student.id}/edit`);
    const loadUntil = async (label: string) => {
      while (
        !(await page.getByRole("textbox", { name: label, exact: true }).count())
      ) {
        const before = await page.getByRole("textbox").count();
        await page
          .getByRole("button", { name: "تحميل المزيد من الحقول", exact: true })
          .click({ timeout: 5000 });
        await expect
          .poll(() => page.getByRole("textbox").count())
          .toBeGreaterThan(before);
      }
    };
    await loadUntil(label);
    await expect(
      page.getByRole("textbox", { name: label, exact: true }),
    ).toHaveValue("SAVED-LATER-PAGE");
    await page
      .getByRole("textbox", { name: "اسم الطالب", exact: true })
      .fill(`CUSTOM62 recovery draft ${stamp}`);
    expect(
      (
        await write(page, `students/${student.id}`, "PATCH", {
          name: `CUSTOM62 colleague ${stamp}`,
          branch_ids: [],
          revision: student.revision,
        })
      ).status,
    ).toBe(200);
    const currentLabel = `CUSTOM62 recovered label ${stamp}`;
    expect(
      (
        await write(page, `student-custom-fields/${field.id}`, "PATCH", {
          label: currentLabel,
          position: field.position,
          required: true,
          revision: field.revision,
        })
      ).status,
    ).toBe(200);
    await page
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    await page
      .getByRole("button", { name: "تحميل أحدث بيانات الطالب", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "اسم الطالب", exact: true }),
    ).toHaveValue(`CUSTOM62 colleague ${stamp}`);
    await expect(
      page.getByRole("textbox", { name: label, exact: true }),
    ).toHaveCount(0);
    await loadUntil(currentLabel);
    await expect(
      page.getByRole("textbox", { name: currentLabel, exact: true }),
    ).toHaveValue("SAVED-LATER-PAGE");
    await page
      .getByRole("textbox", { name: "اسم الطالب", exact: true })
      .fill(`CUSTOM62 recovered student ${stamp}`);
    await page
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/students/${student.id}\\?focus=edit$`),
    );
  } finally {
    test.setTimeout(65000);
    const latest = (
      await (
        await page.request.get(
          `${origin}/api/v1/center/student-custom-fields/${field.id}`,
        )
      ).json()
    ).field;
    await write(page, `student-custom-fields/${field.id}`, "PATCH", {
      label: latest.label,
      position: latest.position,
      required: false,
      revision: latest.revision,
    });
  }
});

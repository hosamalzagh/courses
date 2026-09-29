import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Member, StudentCustomField } from "@/lib/server-context";

test.skip(
  !process.env.COURSES_LIFECYCLE_CREDENTIALS,
  "Requires the disposable student-custom-field-lifecycle PostgreSQL fixture.",
);
const origin =
  process.env.COURSES_LIFECYCLE_ORIGIN ?? "http://alpha.courses.test:8057";
const credentials = process.env.COURSES_LIFECYCLE_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.COURSES_LIFECYCLE_CREDENTIALS, "utf8"))
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

async function openDefinition(
  page: Page,
  field: { id: string; label: string },
) {
  for (let batch = 1; ; batch++) {
    const data = await (
      await page.request.get(
        `${origin}/api/v1/center/student-custom-fields?manage=1&page=${batch}`,
      )
    ).json();
    if (data.fields.some((item: { id: string }) => item.id === field.id)) {
      await page.goto(`${origin}/admin/student-custom-fields?page=${batch}`);
      await page
        .getByRole("searchbox", { name: "بحث في حقول المركز", exact: true })
        .fill(field.label);
      await page
        .getByRole("row")
        .filter({ hasText: field.label })
        .getByRole("button", { name: "تعديل", exact: true })
        .click();
      return;
    }
    expect(data.pagination.has_more).toBe(true);
  }
}
async function loadField(page: Page, label: string) {
  while (
    !(await page.getByRole("combobox", { name: label, exact: true }).count()) &&
    !(await page.getByRole("textbox", { name: label, exact: true }).count())
  ) {
    const before = await page
      .getByRole("group", { name: "الحقول الإضافية", exact: true })
      .locator('[data-slot="field"]')
      .count();
    await page
      .getByRole("button", { name: "تحميل المزيد من الحقول", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .getByRole("group", { name: "الحقول الإضافية", exact: true })
          .locator('[data-slot="field"]')
          .count(),
      )
      .toBeGreaterThan(before);
  }
}

test("disable a used option and field through the manager UI while preserving current values and version history", async ({
  page,
}) => {
  await signIn(page);
  const label = `CUSTOM63 selection ${Date.now()}`;
  const field = (
    await write(page, "student-custom-fields", "POST", {
      id: crypto.randomUUID(),
      label,
      type: "select",
      required: false,
      position: 0,
      options: ["قديم", "جديد"],
    })
  ).body.field;
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  const student = (
    await write(page, "students", "POST", {
      name: `CUSTOM63 student ${Date.now()}`,
      branch_ids: [workspace.branches[0].id],
      request_id: crypto.randomUUID(),
      custom_values: { [field.id]: "قديم" },
    })
  ).body.student;
  await openDefinition(page, field);
  await expect(
    page.getByRole("checkbox", { name: "تعطيل اختيار قديم", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "تعطيل اختيار قديم", exact: true })
    .check();
  await expect(
    page.getByRole("combobox", { name: "نوع الحقل", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "حفظ الحقل", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "إضافة حقل", exact: true }),
  ).toBeVisible();
  await page.goto(`${origin}/admin/students/new`);
  await loadField(page, label);
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await expect(
    page.getByRole("option", { name: "قديم — معطل", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  const rejected = await write(page, "students", "POST", {
    name: "اختيار موقوف جديد",
    branch_ids: [workspace.branches[0].id],
    request_id: crypto.randomUUID(),
    custom_values: { [field.id]: "قديم" },
  });
  expect(rejected.status).toBe(422);
  await page.goto(`${origin}/admin/students/${student.id}/edit`);
  await loadField(page, label);
  await expect(
    page.getByRole("combobox", { name: label, exact: true }),
  ).toContainText("قديم");
  await page
    .getByRole("textbox", { name: "جهة العمل", exact: true })
    .fill("تعديل عام يحفظ القديم");
  await page
    .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/students/${student.id}\\?focus=edit$`),
  );
  await page.goto(`${origin}/admin/students/${student.id}/edit`);
  await loadField(page, label);
  await select(page, label, "جديد");
  await page
    .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/students/${student.id}\\?focus=edit$`),
  );
  await page
    .getByRole("link", { name: "تاريخ الحقول الإضافية", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "قديم", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "جديد", exact: true }),
  ).toBeVisible();
  await openDefinition(page, field);
  await page
    .getByRole("checkbox", { name: "الحقل فعال", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "حفظ الحقل", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "إضافة حقل", exact: true }),
  ).toBeVisible();
  await page.goto(`${origin}/admin/students/${student.id}/edit`);
  // The disabled definition remains readable, without an editable control.
  while (!(await page.getByText(`${label} — معطل`, { exact: true }).count())) {
    const before = await page
      .getByRole("group", { name: "الحقول الإضافية", exact: true })
      .textContent();
    await page
      .getByRole("button", { name: "تحميل المزيد من الحقول", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .getByRole("group", { name: "الحقول الإضافية", exact: true })
          .textContent(),
      )
      .not.toBe(before);
  }
  await expect(
    page.getByRole("combobox", { name: label, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("جديد", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "جهة العمل", exact: true })
    .fill("الحقل متوقف وقيمته محفوظة");
  await page
    .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/students/${student.id}\\?focus=edit$`),
  );
  await page
    .getByRole("link", { name: "تاريخ الحقول الإضافية", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "قديم", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "جديد", exact: true }),
  ).toBeVisible();
});

test("manager classification and owner identity grants control the next open-editor write and all current history reads", async ({
  browser,
}) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  let member: Member | undefined;
  let field: StudentCustomField | undefined;
  try {
    await signIn(owner);
    await signIn(staff, "staff");
    const workspace = await (
      await owner.request.get(`${origin}/api/v1/center/student-workspace`)
    ).json();
    const north = workspace.branches[0];
    const south = workspace.branches[1];
    const members = (
      await (
        await owner.request.get(`${origin}/api/v1/center/member-workspace`)
      ).json()
    ).members;
    member = members.find(
      (item: Member) => item.user.email === credentials.staff.email,
    );
    if (!member) throw new Error("Staff membership is missing");
    expect(
      (
        await write(owner, `members/${member.id}/grants`, "PUT", {
          center_roles: [],
          branch_roles: {
            [north.id]: ["registration", "branch_auditor"],
            [south.id]: ["registration", "student_identity"],
          },
        })
      ).status,
    ).toBe(200);
    const label = `CUSTOM63 private ${Date.now()}`;
    field = (
      await write(owner, "student-custom-fields", "POST", {
        id: `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`,
        label,
        type: "text",
        required: false,
        position: 0,
        options: [],
      })
    ).body.field;
    if (!field) throw new Error("Custom field is missing");
    const value = `PRIVATE-CUSTOM63-${Date.now()}`;
    const student = (
      await write(owner, "students", "POST", {
        name: `CUSTOM63 identity student ${Date.now()}`,
        branch_ids: [north.id],
        request_id: crypto.randomUUID(),
        custom_values: { [field.id]: value },
      })
    ).body.student;
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    await loadField(staff, label);
    await staff
      .getByRole("textbox", { name: label, exact: true })
      .fill("مسودة قبل التصنيف");
    await openDefinition(owner, field);
    await select(owner, "تصنيف الحقل", "بيانات هوية مقيدة");
    await owner
      .getByRole("checkbox", { name: "حقل مطلوب", exact: true })
      .check();
    await owner.getByRole("button", { name: "حفظ الحقل", exact: true }).click();
    await expect(
      owner.getByRole("button", { name: "إضافة حقل", exact: true }),
    ).toBeVisible();
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
      staff.getByRole("textbox", { name: label, exact: true }),
    ).toHaveValue("مسودة قبل التصنيف");
    await staff.getByRole("link", { name: "إلغاء", exact: true }).click();
    await staff
      .getByRole("alertdialog")
      .getByRole("button", { name: "مغادرة دون حفظ", exact: true })
      .click();
    await expect(staff).toHaveURL(
      new RegExp(`/students/${student.id}\\?focus=edit$`),
    );
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    await expect(
      staff.getByRole("textbox", { name: label, exact: true }),
    ).toHaveCount(0);
    expect(await staff.content()).not.toContain(value);
    await staff
      .getByRole("textbox", { name: "جهة العمل", exact: true })
      .fill("تعديل عام يحفظ الهوية المحجوبة");
    await staff
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    await expect(staff).toHaveURL(
      new RegExp(`/students/${student.id}\\?focus=edit$`),
    );
    await staff
      .getByRole("link", { name: "تاريخ الحقول الإضافية", exact: true })
      .click();
    await expect(
      staff.getByText("لا يوجد تاريخ متاح ضمن صلاحياتك.", { exact: true }),
    ).toBeVisible();
    expect(await staff.content()).not.toContain(value);
    await staff.goto(`${origin}/admin/students/new`);
    await expect(
      staff.getByRole("textbox", { name: label, exact: true }),
    ).toHaveCount(0);
    const draft = `CUSTOM63 missing private ${Date.now()}`;
    await staff
      .getByRole("textbox", { name: "اسم الطالب", exact: true })
      .fill(draft);
    const missing = staff.waitForResponse(
      (response) =>
        response.url().endsWith("/students") &&
        response.request().method() === "POST",
    );
    await staff
      .getByRole("button", { name: "حفظ ملف الطالب", exact: true })
      .click();
    expect((await missing).status()).toBe(422);
    await expect(
      staff.getByRole("group", { name: "الحقول الإضافية", exact: true }),
    ).toContainText("موظف مخول");
    await expect(
      staff.getByRole("textbox", { name: "اسم الطالب", exact: true }),
    ).toHaveValue(draft);
    expect(await staff.content()).not.toContain(value);
    await owner.goto(`${origin}/admin/members`);
    await owner
      .getByRole("row")
      .filter({ hasText: credentials.staff.email })
      .getByRole("button", { name: "تعديل الأدوار", exact: true })
      .click();
    await owner
      .getByRole("group", { name: north.name, exact: true })
      .getByRole("checkbox", { name: "بيانات هوية الطالب", exact: true })
      .check();
    await owner
      .getByRole("button", { name: "حفظ الأدوار", exact: true })
      .click();
    await owner
      .getByRole("alertdialog")
      .getByRole("button", { name: "حفظ التغيير", exact: true })
      .click();
    await expect(
      owner.getByRole("status").filter({ hasText: "حُفظت أدوار الموظف" }),
    ).toBeVisible();
    await staff.goto(
      `${origin}/admin/students/${student.id}?tab=custom-history`,
    );
    await expect(
      staff.getByRole("cell", { name: value, exact: true }),
    ).toBeVisible();
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    await loadField(staff, label);
    await expect(
      staff.getByRole("textbox", { name: label, exact: true }),
    ).toHaveValue(value);
    await staff
      .getByRole("textbox", { name: label, exact: true })
      .fill("مسودة بعد سحب المنحة");
    expect(
      (
        await write(owner, `members/${member.id}/grants`, "PUT", {
          center_roles: [],
          branch_roles: { [north.id]: ["registration", "branch_auditor"] },
        })
      ).status,
    ).toBe(200);
    const revoked = staff.waitForResponse(
      (response) =>
        response.url().endsWith(`/students/${student.id}`) &&
        response.request().method() === "PATCH",
    );
    await staff
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    expect((await revoked).status()).toBe(403);
    await expect(
      staff.getByRole("textbox", { name: label, exact: true }),
    ).toHaveValue("مسودة بعد سحب المنحة");
    for (const route of [
      `students/${student.id}?tab=custom-history`,
      `student-custom-fields?student_id=${student.id}`,
      "audit",
      "student-search-workspace",
      `students/similar?name=${encodeURIComponent(student.name)}`,
    ]) {
      const response = await staff.request.get(
        `${origin}/api/v1/center/${route}`,
      );
      expect(await response.text()).not.toContain(value);
    }
    const current = (
      await (
        await owner.request.get(
          `${origin}/api/v1/center/students/${student.id}`,
        )
      ).json()
    ).students[0];
    expect(current.employer).toBe("تعديل عام يحفظ الهوية المحجوبة");
    expect(current.custom_values[field.id]).toBe(value);
    const beta = await browser.newPage();
    try {
      await signIn(beta, "beta");
      const betaOrigin = origin.replace("alpha.", "beta.");
      expect(
        (
          await beta.request.get(
            `${betaOrigin}/api/v1/center/students/${student.id}?tab=custom-history`,
          )
        ).status(),
      ).toBe(404);
      const created = await write(beta, "student-custom-fields", "POST", {
        id: field.id,
        label: "CUSTOM63 independent identity",
        type: "text",
        required: false,
        position: 0,
        options: [],
        classification: "identity",
      });
      expect(created.status).toBe(201);
      const betaWorkspace = await (
        await beta.request.get(`${betaOrigin}/api/v1/center/student-workspace`)
      ).json();
      const betaStudent = (
        await write(beta, "students", "POST", {
          name: `CUSTOM63 beta ${Date.now()}`,
          branch_ids: [betaWorkspace.branches[0].id],
          request_id: crypto.randomUUID(),
          custom_values: { [field.id]: "BETA-PRIVATE-ONLY" },
        })
      ).body.student;
      await beta.goto(
        `${betaOrigin}/admin/students/${betaStudent.id}?tab=custom-history`,
      );
      await expect(
        beta.getByRole("cell", { name: "BETA-PRIVATE-ONLY", exact: true }),
      ).toBeVisible();
      expect(await beta.content()).not.toContain(value);
      expect(
        await (
          await owner.request.get(
            `${origin}/api/v1/center/students/${student.id}?tab=custom-history`,
          )
        ).text(),
      ).not.toContain("BETA-PRIVATE-ONLY");
    } finally {
      await beta.close();
    }
  } finally {
    if (field) {
      const current = (
        await (
          await owner.request.get(
            `${origin}/api/v1/center/student-custom-fields/${field.id}`,
          )
        ).json()
      ).field;
      await write(owner, `student-custom-fields/${field.id}`, "PATCH", {
        label: current.label,
        position: current.position,
        required: false,
        revision: current.revision,
      });
    }
    if (member)
      await write(owner, `members/${member.id}/grants`, "PUT", {
        center_roles: member.center_roles,
        branch_roles: member.branch_roles,
      });
    await owner.close();
    await staff.close();
  }
});

test("mixed branch authority exposes identity values read-only while general profile edits remain available", async ({
  browser,
}) => {
  const owner = await browser.newPage();
  const staff = await browser.newPage();
  let member: Member | undefined;
  try {
    await signIn(owner);
    await signIn(staff, "staff");
    const workspace = await (
      await owner.request.get(`${origin}/api/v1/center/student-workspace`)
    ).json();
    const [north, south] = workspace.branches;
    const members = (
      await (
        await owner.request.get(`${origin}/api/v1/center/member-workspace`)
      ).json()
    ).members;
    member = members.find(
      (item: Member) => item.user.email === credentials.staff.email,
    );
    if (!member) throw new Error("Staff membership is missing");
    expect(
      (
        await write(owner, `members/${member.id}/grants`, "PUT", {
          center_roles: [],
          branch_roles: {
            [north.id]: ["registration"],
            [south.id]: ["branch_viewer", "student_identity"],
          },
        })
      ).status,
    ).toBe(200);
    const label = `CUSTOM63 readonly ${Date.now()}`;
    const field = (
      await write(owner, "student-custom-fields", "POST", {
        id: crypto.randomUUID(),
        label,
        type: "text",
        required: false,
        position: 0,
        options: [],
        classification: "identity",
      })
    ).body.field;
    const value = `READONLY-CUSTOM63-${Date.now()}`;
    const student = (
      await write(owner, "students", "POST", {
        name: `CUSTOM63 mixed branches ${Date.now()}`,
        branch_ids: [north.id, south.id],
        request_id: crypto.randomUUID(),
        custom_values: { [field.id]: value },
      })
    ).body.student;
    const data = await (
      await staff.request.get(`${origin}/api/v1/center/students/${student.id}`)
    ).json();
    expect(data.students[0]).toMatchObject({
      can_manage: true,
      can_read_identity: true,
      can_manage_identity: false,
    });
    await staff.goto(`${origin}/admin/students/${student.id}/edit`);
    while (!(await staff.getByText(value, { exact: true }).count())) {
      if (
        await staff.getByRole("textbox", { name: label, exact: true }).count()
      )
        break;
      await staff
        .getByRole("button", { name: "تحميل المزيد من الحقول", exact: true })
        .click();
      await expect(
        staff.getByRole("button", {
          name: "تحميل المزيد من الحقول",
          exact: true,
        }),
      ).toBeEnabled();
    }
    await expect(
      staff.getByRole("textbox", { name: label, exact: true }),
    ).toHaveCount(0);
    await expect(
      staff.getByText(`${label} — للقراءة فقط`, { exact: true }),
    ).toBeVisible();
    await expect(staff.getByText(value, { exact: true })).toBeVisible();
    await staff
      .getByRole("textbox", { name: "جهة العمل", exact: true })
      .fill("تعديل عام بصلاحية قراءة الهوية فقط");
    await staff
      .getByRole("button", { name: "حفظ بيانات الطالب", exact: true })
      .click();
    await expect(staff).toHaveURL(
      new RegExp(`/students/${student.id}\\?focus=edit$`),
    );
    const current = await (
      await owner.request.get(
        `${origin}/api/v1/center/students/${student.id}?tab=custom-history`,
      )
    ).json();
    expect(current.students[0].employer).toBe(
      "تعديل عام بصلاحية قراءة الهوية فقط",
    );
    expect(current.students[0].custom_values[field.id]).toBe(value);
    expect(
      current.custom_history.entries.filter(
        (entry: { field_id: string }) => entry.field_id === field.id,
      ),
    ).toHaveLength(1);
  } finally {
    if (member)
      await write(owner, `members/${member.id}/grants`, "PUT", {
        center_roles: member.center_roles,
        branch_roles: member.branch_roles,
      });
    await owner.close();
    await staff.close();
  }
});

test("history is bounded and the shared header remains usable in RTL themes with measured cold and warm reads", async ({
  page,
}) => {
  test.skip(
    !process.env.COURSES_LIFECYCLE_READ_LOG,
    "Requires SSR-aware proxy read log",
  );
  await signIn(page);
  const workspace = await (
    await page.request.get(`${origin}/api/v1/center/student-workspace`)
  ).json();
  const label = `CUSTOM63 bounded ${Date.now()}`;
  const field = (
    await write(page, "student-custom-fields", "POST", {
      id: crypto.randomUUID(),
      label,
      type: "text",
      required: false,
      position: 0,
      options: [],
    })
  ).body.field;
  const student = (
    await write(page, "students", "POST", {
      name: `CUSTOM63 history ${Date.now()}`,
      branch_ids: [workspace.branches[0].id],
      request_id: crypto.randomUUID(),
      custom_values: { [field.id]: "VERSION-0" },
    })
  ).body.student;
  for (let revision = 1; revision <= 55; revision++)
    expect(
      (
        await write(page, `students/${student.id}`, "PATCH", {
          name: student.name,
          branch_ids: [],
          revision,
          custom_values: { [field.id]: `VERSION-${revision}` },
        })
      ).status,
    ).toBe(200);
  const file = process.env.COURSES_LIFECYCLE_READ_LOG!;
  const cursor = () =>
    readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
  const reads = (start: number) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(start)
      .map((line) => JSON.parse(line))
      .filter(
        (row) =>
          row.host?.startsWith("alpha.") &&
          row.path?.startsWith("/api/v1/center/"),
      ) as { count: number | null; ms: number | null }[];
  for (const route of [
    "/admin/settings?tab=student-fields",
    "/admin/students/new",
    `/admin/students/${student.id}`,
    `/admin/students/${student.id}/edit`,
    `/admin/students/${student.id}?tab=custom-history`,
    `/admin/students/${student.id}?tab=custom-history&custom_history_page=2`,
  ]) {
    const start = cursor();
    await page.goto(`${origin}${route}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const rows = reads(start);
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
    const sql = rows.reduce((sum, row) => sum + row.count!, 0);
    console.log(
      JSON.stringify({
        route,
        sql,
        sql_ms: rows.reduce((sum, row) => sum + row.ms!, 0),
      }),
    );
    expect(sql).toBeLessThanOrEqual(6);
  }
  const response = await page.request.get(
    `${origin}/api/v1/center/students/${student.id}?tab=custom-history`,
  );
  const body = await response.json();
  expect(body.custom_history.entries).toHaveLength(50);
  expect(body.custom_history.pagination.has_more).toBe(true);
  await expect(
    page.getByRole("cell", { name: "VERSION-0", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/courses-issue57/history-desktop-light.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "تفعيل الوضع الداكن", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "/tmp/courses-issue57/history-desktop-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/courses-issue57/history-mobile-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const previous = page.getByRole("link", {
    name: "تاريخ الحقول — الدفعة السابقة",
    exact: true,
  });
  expect(
    await previous.evaluate((link) => Boolean(link.closest("header"))),
  ).toBe(true);
  await previous.focus();
  await previous.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(
      `/students/${student.id}\\?tab=custom-history&custom_history_page=1$`,
    ),
  );
  await expect(
    page.getByRole("cell", { name: "VERSION-55", exact: true }),
  ).toBeVisible();
  await page
    .locator(".center-topbar")
    .evaluate((element) =>
      element.setAttribute("data-lifecycle-shell", "retained"),
    );
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  const start = cursor();
  const personal = page.getByRole("link", {
    name: "البيانات الشخصية",
    exact: true,
  });
  await personal.hover();
  await expect.poll(() => reads(start).length).toBeGreaterThan(0);
  await personal.click();
  await expect(page).toHaveURL(new RegExp(`/students/${student.id}$`));
  await expect(page.locator(".center-topbar")).toHaveAttribute(
    "data-lifecycle-shell",
    "retained",
  );
  expect(documents).toEqual([]);
  const warm = reads(start);
  expect(
    warm.every(
      (row) => typeof row.count === "number" && typeof row.ms === "number",
    ),
  ).toBe(true);
  expect(warm.reduce((sum, row) => sum + row.count!, 0)).toBeLessThanOrEqual(6);
});

"use client";

import { buttonVariants } from "./ui/button";
import { DataTable } from "./DataTable";
import { CenterHeaderActions } from "./CenterShell";
import { PrefetchLink as Link } from "./PrefetchLink";
import {
  customFieldTypeLabels,
  customFieldValue,
} from "@/lib/student-custom-fields";
import type { StudentCustomHistory } from "@/lib/server-context";

export function StudentCustomFieldHistory({
  history,
  studentId,
}: {
  history: StudentCustomHistory;
  studentId: string;
}) {
  const route = (page: number) =>
    `/admin/students/${studentId}?tab=custom-history&custom_history_page=${page}`;
  return (
    <>
      <DataTable
        id="student-custom-history"
        title="تاريخ الحقول الإضافية"
        rows={history.entries}
        rowKey={(entry) => entry.id}
        searchText={(entry) =>
          `${entry.label} ${customFieldValue(entry.value)} ${entry.actor_name ?? ""}`
        }
        emptyMessage="لا يوجد تاريخ متاح ضمن صلاحياتك."
        description="القيم السابقة محفوظة. يتبع الوصول تصنيف الحقل وصلاحيات الهوية الحالية؛ دفعات محدودة من 50 تغييرًا."
        columns={[
          {
            key: "field",
            label: "الحقل",
            render: (entry) => (
              <>
                {entry.label}
                {entry.active ? "" : " — معطل"}
              </>
            ),
          },
          {
            key: "type",
            label: "النوع",
            render: (entry) => customFieldTypeLabels[entry.type],
          },
          {
            key: "value",
            label: "القيمة المحفوظة",
            render: (entry) => (
              <bdi>
                {entry.value === null
                  ? "مسح القيمة"
                  : customFieldValue(entry.value)}
              </bdi>
            ),
          },
          {
            key: "actor",
            label: "الموظف",
            render: (entry) =>
              entry.imported
                ? "قيمة سابقة قبل حفظ النسخ"
                : (entry.actor_name ?? "موظف غير محدد"),
          },
          {
            key: "revision",
            label: "مراجعة الملف",
            render: (entry) => entry.profile_revision.toLocaleString("ar-EG"),
          },
          {
            key: "time",
            label: "التاريخ",
            render: (entry) =>
              new Intl.DateTimeFormat("ar-EG", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "Africa/Cairo",
              }).format(new Date(entry.created_at.replace(" ", "T") + "Z")),
          },
        ]}
      />
      <CenterHeaderActions>
        {history.pagination.page > 1 ? (
          <Link
            className={buttonVariants({ variant: "outline" })}
            href={route(history.pagination.page - 1)}
          >
            تاريخ الحقول — الدفعة السابقة
          </Link>
        ) : null}
        {history.pagination.has_more ? (
          <Link
            className={buttonVariants({ variant: "outline" })}
            href={route(history.pagination.page + 1)}
          >
            تاريخ الحقول — الدفعة التالية
          </Link>
        ) : null}
      </CenterHeaderActions>
    </>
  );
}

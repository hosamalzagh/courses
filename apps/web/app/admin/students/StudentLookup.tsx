"use client";

import { useId, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/DataTable";
import { ChoiceField } from "@/components/ChoiceField";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { StudentContext, StudentSearchContext } from "@/lib/server-context";
import { canReadStudents, canSearchCenterStudents } from "@/lib/student-search-access";
import { StudentSharingControls } from "./StudentSharingControls";

type Props =
  | { scope: "branches"; context: StudentContext; query: string; identifier: string; mode: "general" | "identifier" }
  | { scope: "center"; context: StudentSearchContext; query: string };

type LookupRow = { id: string; student_number: number; name: string; phone: string | null; within_scope: boolean };

export function StudentLookup(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const methodId = useId();
  const { context, scope } = props;
  const branchContext = props.scope === "branches" ? props.context : null;
  const canRead = canReadStudents(context);
  const canSearchCenter = canSearchCenterStudents(context);
  const centerEnabled = scope === "center" ? context.can_search : context.student_search_enabled;
  const mode = props.scope === "branches" ? props.mode : "general";
  const value = props.scope === "branches" && mode === "identifier" ? props.identifier : props.query;
  const started = value.trim() !== "";
  const roster = Boolean(branchContext && mode === "general" && !started);
  const rows: LookupRow[] = started ? scope === "center"
    ? context.students
    : context.students.map((student) => ({
      id: student.id, student_number: student.student_number, name: student.name,
      phone: student.phone, within_scope: true,
    })) : [];

  function href(search: string, page = 1) {
    const params = new URLSearchParams({ scope });
    if (scope === "branches" && mode === "identifier") params.set("mode", "identifier");
    if (search) params.set(scope === "branches" && mode === "identifier" ? "identifier" : "q", search);
    if (page > 1) params.set("page", String(page));
    return `/admin/students?${params}`;
  }

  function changeScope(next: string) {
    if (next !== "branches" && next !== "center" || next === scope) return;
    const params = new URLSearchParams({ scope: next });
    if (mode === "general" && props.query.trim()) params.set("q", props.query.trim());
    startTransition(() => router.push(`/admin/students?${params}`));
  }

  function changeMode(next: string) {
    if (scope !== "branches" || next !== "general" && next !== "identifier" || next === mode) return;
    const params = new URLSearchParams({ scope: "branches" });
    if (next === "identifier") params.set("mode", "identifier");
    startTransition(() => router.push(`/admin/students?${params}`));
  }

  const searchLabel = mode === "identifier" ? "رقم الطالب الداخلي أو الباركود" : "الاسم أو رقم الطالب الداخلي أو رقم التواصل";
  const search = { value, onSearch: (term: string) => startTransition(() => router.push(href(term.trim()))), label: searchLabel, placeholder: mode === "identifier" ? "اكتب الرقم الداخلي أو الباركود" : "ابحث بالاسم أو الرقم أو الهاتف", pending };

  return <div className="student-lookup">
    <div className="student-lookup-options">
      {canRead && canSearchCenter ? <FieldSet className="student-lookup-scope"><FieldLegend>نطاق البحث</FieldLegend>
        <RadioGroup value={scope} onValueChange={(next) => changeScope(String(next))} disabled={pending} className="student-lookup-scope-options">
          <FieldLabel className="student-lookup-scope-option"><RadioGroupItem value="branches" />فروعي</FieldLabel>
          <FieldLabel className="student-lookup-scope-option"><RadioGroupItem value="center" disabled={!centerEnabled && scope !== "center"} />كل المركز</FieldLabel>
        </RadioGroup>
      </FieldSet> : <p className="student-lookup-current-scope">نطاق البحث: <strong>{scope === "center" ? "كل المركز" : "فروعي"}</strong></p>}
      {branchContext ? <div className="student-lookup-method"><ChoiceField id={`${methodId}-method`} label="طريقة البحث" value={mode} disabled={pending} onChange={changeMode} items={[
        { value: "general", label: "الاسم أو الرقم أو التواصل" },
        { value: "identifier", label: `الرقم الداخلي أو ${branchContext.student_code_settings.enabled ? branchContext.student_code_settings.label : "الباركود"}` },
      ]} /></div> : null}
    </div>
    {canSearchCenter && !centerEnabled ? <p className="student-lookup-policy">البحث في كل المركز غير مفعّل حاليًا. {context.permissions.can_manage_center
      ? <Link href="/admin/settings?tab=students">إدارة إتاحة البحث</Link>
      : "يمكن لمدير المركز تفعيله."}</p> : null}
    {scope === "center" && !centerEnabled ? null : <>
      {scope === "center" ? <p className="muted student-lookup-privacy">ملفات الفروع الأخرى تعرض الاسم والرقم الداخلي وهاتف الملخص فقط.</p> : null}
      {roster && branchContext ? <DataTable id="students" title="الطلاب في فروعي" description="حتى ٥٠ ملفًا في الدفعة." rows={branchContext.students} rowKey={(student) => student.id}
        searchText={(student) => `${student.student_number} ${student.name} ${student.phone ?? ""}`} emptyMessage="لا توجد ملفات طلاب متاحة. أنشئ ملفًا إذا كانت لديك صلاحية التسجيل."
        serverSearch={search} serverPagination={{ page: branchContext.pagination.page, hasMore: branchContext.pagination.has_more, batchSize: 50, previousHref: href("", branchContext.pagination.page - 1), nextHref: href("", branchContext.pagination.page + 1) }}
        columns={[
          { key: "number", label: "رقم الطالب الداخلي", filterText: (student) => String(student.student_number), render: (student) => <Link className="table-code" href={`/admin/students/${student.id}`}>{student.student_number.toLocaleString("ar-EG")}</Link> },
          { key: "name", label: "الطالب", filterText: (student) => student.name, render: (student) => <h3>{student.name}</h3> },
          { key: "status", label: "حالة الملف", filterText: (student) => student.status === "active" ? "نشط" : "موقوف", render: (student) => student.status === "active" ? "نشط" : "موقوف" },
          { key: "phone", label: "رقم التواصل", filterText: (student) => student.phone ?? "", render: (student) => <bdi dir="ltr">{student.phone || "لم يُضف رقم تواصل"}</bdi> },
          { key: "branches", label: "الفروع المصرح بها", filterText: (student) => student.branch_ids.map((id) => branchContext.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join("، "), render: (student) => student.branch_ids.map((id) => branchContext.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join("، ") },
          { key: "actions", label: "الإجراءات", actions: true, render: (student) => <div className="student-row-actions">{student.can_manage ? <Link href={`/admin/students/${student.id}/edit`}>تعديل ملف الطالب</Link> : <span className="muted">صلاحية عرض فقط</span>}<StudentSharingControls student={student} compact /></div> },
        ]} /> : <DataTable id={`student-lookup-${scope}`} title="نتائج البحث" description={started && rows.length ? "حتى ٥٠ نتيجة في الدفعة. انتقل إلى الدفعة التالية لمتابعة البحث." : undefined}
        pageSize={50} rows={rows} rowKey={(student) => student.id} searchText={(student) => `${student.student_number} ${student.name} ${student.phone ?? ""}`}
        emptyMessage={!started ? mode === "identifier" ? "أدخل رقم الطالب الداخلي أو الباركود لبدء البحث." : "اكتب الاسم أو رقم الطالب الداخلي أو رقم التواصل لبدء البحث." : scope === "center" ? "لا يوجد طالب مطابق ضمن الملفات المتاحة للبحث." : "لا يوجد طالب مطابق ضمن فروعك."}
        lookup={{ started }} serverSearch={search}
        serverPagination={started ? { page: context.pagination.page, hasMore: context.pagination.has_more, batchSize: 50, previousHref: href(value, context.pagination.page - 1), nextHref: href(value, context.pagination.page + 1) } : undefined}
        columns={[
          { key: "number", label: "رقم الطالب الداخلي", render: (student) => <span className="table-code">{student.student_number.toLocaleString("ar-EG")}</span> },
          { key: "name", label: "الطالب", render: (student) => <h3>{student.name}</h3> },
          { key: "phone", label: "رقم التواصل", render: (student) => <bdi dir="ltr">{student.phone || "لم يُضف رقم تواصل"}</bdi> },
          { key: "access", label: "إتاحة الملف", actions: true, render: (student) => student.within_scope
            ? <Link href={`/admin/students/${student.id}`}>فتح ملف الطالب</Link>
            : <span className="muted">بيانات أساسية فقط · خارج فروعك</span> },
        ]} />}
    </>}
  </div>;
}

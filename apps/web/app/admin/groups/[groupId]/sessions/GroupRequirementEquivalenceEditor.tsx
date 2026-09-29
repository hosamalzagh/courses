"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { SessionContext } from "@/lib/groups";

type Candidate = { id: string; number: number; content: string; title: string | null;
  group_id: string; group_name: string; group_revision: number;
  approval_id: string | null; approval_revision: number | null };
type HistoricalRequirement = SessionContext["group"]["historical_requirements"][number];
type Decision = { kind: "approve" | "revoke"; candidate: Candidate };

export function GroupRequirementEquivalenceEditor({ group, onClose }: {
  group: SessionContext["group"]; onClose: () => void;
}) {
  const formId = useId();
  const busyRef = useRef(false);
  const historyBusyRef = useRef(false);
  const historyErrorRef = useRef<HTMLDivElement>(null);
  const [requiredId, setRequiredId] = useState("");
  const [historical, setHistorical] = useState(group.historical_requirements);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyHasMore, setHistoryHasMore] = useState(group.historical_requirements_has_more);
  const [historySearch, setHistorySearch] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [retainedHistorical, setRetainedHistorical] = useState<HistoricalRequirement | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [groupRevision, setGroupRevision] = useState(group.revision);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const availableRequired = [
    ...group.requirements.filter(item => item.plan_lecture_id === null).map(item => ({ ...item, historical: false })),
    ...historical.map(item => ({ ...item, historical: true })),
  ];
  const required = retainedHistorical && !availableRequired.some(item => item.id === retainedHistorical.id)
    ? [...availableRequired, { ...retainedHistorical, historical: true }] : availableRequired;
  const selected = required.find(item => item.id === requiredId);
  const prefix = `groups/${group.id}/requirement-equivalences`;

  const loadHistorical = useCallback(async (nextPage: number, q: string) => {
    if (historyBusyRef.current) return;
    historyBusyRef.current = true; setHistoryBusy(true); setHistoryError("");
    try {
      const params = new URLSearchParams({ page: String(nextPage) });
      if (q.trim()) params.set("q", q.trim());
      const response = await centerRequest(`${prefix}/requirements?${params}`, "GET");
      if (!response.ok) { setHistoryError(await responseMessage(response)); return; }
      const result = await response.json() as { requirements: HistoricalRequirement[];
        pagination: { has_more: boolean } };
      setHistorical(current => nextPage > 1 ? [...current, ...result.requirements] : result.requirements);
      setHistoryPage(nextPage); setHistoryHasMore(result.pagination.has_more);
      if (nextPage === 1) setHistoryQuery(q.trim());
    } catch { setHistoryError("تعذر تحميل المتطلبات التاريخية. حاول مرة أخرى."); }
    finally { historyBusyRef.current = false; setHistoryBusy(false); }
  }, [prefix]);
  useEffect(() => { if (historyError) historyErrorRef.current?.focus(); }, [historyError]);

  const load = useCallback(async (id: string, nextPage: number, q: string) => {
    if (!id || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ required_requirement_id: id, page: String(nextPage) });
      if (q.trim()) params.set("q", q.trim());
      const response = await centerRequest(`${prefix}/options?${params}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const result = await response.json() as { group_revision: number; candidates: Candidate[];
        pagination: { has_more: boolean } };
      setCandidates(current => nextPage > 1 ? [...current, ...result.candidates] : result.candidates);
      setGroupRevision(result.group_revision); setPage(nextPage);
      setHasMore(result.pagination.has_more); setConflict(false);
    } catch { setError("تعذر تحميل المتطلبات المضافة في المجموعات الأخرى."); }
    finally { busyRef.current = false; setBusy(false); }
  }, [prefix]);
  useEffect(() => {
    if (!requiredId) return;
    const timeout = window.setTimeout(() => void load(requiredId, 1, ""), 0);
    return () => window.clearTimeout(timeout);
  }, [requiredId, load]);

  async function confirm() {
    if (!decision || !selected || busyRef.current || reason.trim().length < 3) return;
    busyRef.current = true; setBusy(true); setError("");
    const current = decision;
    try {
      const route = current.kind === "approve" ? prefix : `${prefix}/${current.candidate.approval_id}/revoke`;
      const payload = current.kind === "approve"
        ? { required_requirement_id: selected.id, candidate_requirement_id: current.candidate.id,
          required_group_revision: groupRevision, candidate_group_revision: current.candidate.group_revision,
          reason: reason.trim(), request_id: requestId }
        : { revision: current.candidate.approval_revision, reason: reason.trim(), request_id: requestId };
      const response = await centerRequest(route, "POST", payload);
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setDecision(null); }
        setError(await responseMessage(response)); return;
      }
      setDecision(null); setReason(""); setRequestId(newSubmissionId());
      setNotice(current.kind === "approve" ? "اعتمد تكافؤ المتطلبين وسُجل سببه." : "سُحب الاعتماد؛ سيُعاد حساب الرصيد دون هذا الربط.");
      busyRef.current = false; setBusy(false);
      await load(selected.id, 1, search);
      requestAnimationFrame(() => document.getElementById(`${formId}-required`)?.focus());
    } catch { setError("تعذر التأكد من القرار. أعد التأكيد بنفس الطلب للتحقق من نتيجته."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return <section className="context-card form-stack" aria-labelledby={`${formId}-heading`}>
    <h2 id={`${formId}-heading`} tabIndex={-1}>اعتماد تكافؤ محاضرتين مضافتين</h2>
    <p>اختر متطلب هذه المجموعة ومحاضرة مضافة من مجموعة أخرى في المستوى نفسه. لا يُحتسب التعويض حتى يعتمد الربط صراحة.</p>
    {group.historical_requirements.length > 0 ? <>
      <FormField id={`${formId}-history-search`} label="ابحث عن متطلب تاريخي متقاعد" value={historySearch}
        onChange={setHistorySearch} disabled={historyBusy} />
      <CenterHeaderActions>
        <Button type="button" disabled={historyBusy} onClick={() => void loadHistorical(1, historySearch)}>بحث في المتطلبات التاريخية</Button>
        {historyHasMore ? <Button type="button" disabled={historyBusy} onClick={() => void loadHistorical(historyPage + 1, historyQuery)}>متطلبات تاريخية أخرى</Button> : null}
      </CenterHeaderActions>
      {historyError ? <div ref={historyErrorRef} tabIndex={-1}><InlineNotice tone="error">{historyError}</InlineNotice></div> : null}
    </> : null}
    <Field><FieldLabel htmlFor={`${formId}-required`}>المتطلب المطلوب من هذه المجموعة</FieldLabel>
      <NativeSelect id={`${formId}-required`} value={requiredId} disabled={busy}
        onChange={event => { const item = required.find(requirement => requirement.id === event.target.value);
          setRetainedHistorical(item?.historical ? item as HistoricalRequirement : null);
          setRequiredId(event.target.value); setSearch(""); setCandidates([]); setDecision(null); setError(""); setNotice(""); }}>
        <NativeSelectOption value="">اختر محاضرة مضافة</NativeSelectOption>
        {required.map(item => <NativeSelectOption key={item.id} value={item.id}>
          {item.number.toLocaleString("ar-EG")} · {item.title || item.content}{item.historical ? " · اعتماد تاريخي" : ""}
        </NativeSelectOption>)}
      </NativeSelect>
      <FieldDescription>لا يظهر محتوى الخطة الأصلي هنا؛ له مسار المعادلات المعتمدة بين إصدارات الخطط.</FieldDescription>
    </Field>
    {selected ? <>
      <FormField id={`${formId}-search`} label="بحث عن المجموعة أو المحتوى المقابل" value={search}
        onChange={setSearch} disabled={busy} />
      <CenterHeaderActions>
        <Button disabled={busy} onClick={() => void load(requiredId, 1, search)}>بحث</Button>
        {hasMore ? <Button disabled={busy} onClick={() => void load(requiredId, page + 1, search)}>عرض المزيد</Button> : null}
      </CenterHeaderActions>
      <FormField id={`${formId}-reason`} label="سبب الاعتماد أو السحب" value={reason}
        onChange={value => { setReason(value); setRequestId(newSubmissionId()); }} disabled={busy} required />
      <DataTable id="group-requirement-equivalences" title="متطلبات المجموعات الأخرى" rows={candidates}
        rowKey={row => row.id} searchText={row => `${row.group_name} ${row.content} ${row.number}`}
        emptyMessage="لا توجد محاضرات مضافة مطابقة في المجموعات المصرح بها."
        columns={[
          { key: "group", label: "المجموعة", render: row => row.group_name },
          { key: "content", label: "المحتوى", render: row => `${row.number.toLocaleString("ar-EG")} · ${row.title || row.content}` },
          { key: "status", label: "الحالة", render: row => row.approval_id ? "معتمد" : "غير معتمد" },
          { key: "action", label: "القرار", render: row => <Button disabled={busy || conflict || reason.trim().length < 3}
            onClick={() => { setDecision({ kind: row.approval_id ? "revoke" : "approve", candidate: row }); setRequestId(newSubmissionId()); }}>
            {row.approval_id ? "سحب الاعتماد" : "اعتماد التكافؤ"}
          </Button> },
        ]} />
    </> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    <CenterHeaderActions>
      {conflict && selected ? <Button disabled={busy} onClick={() => void load(selected.id, 1, search)}>تحميل أحدث البيانات</Button> : null}
      <Button disabled={busy} onClick={onClose}>رجوع للجدول</Button>
    </CenterHeaderActions>
    {decision ? <ConfirmationDialog
      title={decision.kind === "approve" ? "تأكيد اعتماد التكافؤ" : "تأكيد سحب التكافؤ"}
      description={`${selected?.content ?? ""} ← ${decision.candidate.content}. السبب: ${reason.trim()}`}
      confirmLabel={decision.kind === "approve" ? "اعتماد الربط" : "سحب الاعتماد"}
      onCancel={() => setDecision(null)} onConfirm={() => void confirm()} /> : null}
  </section>;
}

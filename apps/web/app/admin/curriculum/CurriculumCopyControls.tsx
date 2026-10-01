"use client";

import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import { useWorkspaceRouter as useRouter } from "@/components/WorkspaceNavigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { InlineNotice } from "@/components/InlineNotice";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { Course, CurriculumContext } from "@/lib/curriculum";

type CopyPreview = {
  source: { id: string; name: string; branch_name: string };
  target: { id: number; name: string };
  snapshot_hash: string;
  counts: { stages: number; levels: number; plans: number; lectures: number };
  outline: { kind: "stage" | "level"; name: string; stage_name?: string; plans?: number; lectures?: number }[];
  pagination: { page: number; has_more: boolean };
};

export function CurriculumCopyControls({ course, context, onClose }: {
  course: Course; context: CurriculumContext; onClose: () => void;
}) {
  const router = useRouter();
  const formId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusError = useCallback((node: HTMLDivElement | null) => { node?.focus(); }, []);
  const branches = context.branches.filter(branch => branch.id !== course.branch_id &&
    (context.permissions.can_manage_center || context.permissions.branch_actions?.[String(branch.id)]?.includes("curriculum.manage")));
  const [targetBranchId, setTargetBranchId] = useState(branches[0]?.id ?? 0);
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState<"preview" | "copy" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const pendingKey = (branchId: number) => `curriculum-copy:${context.center.id}:${context.user.id}:${course.id}:${branchId}`;

  async function loadPreview(page = 1) {
    if (!targetBranchId || busy) return;
    setBusy("preview"); setError(""); setNotice("");
    try {
      const stored = localStorage.getItem(pendingKey(targetBranchId));
      if (stored) {
        const pending = JSON.parse(stored) as { target_branch_id: number; snapshot_hash: string; request_id: string };
        if (pending.target_branch_id === targetBranchId) {
          const replay = await centerRequest(`courses/${course.id}/copies`, "POST", pending);
          if (replay.ok) {
            localStorage.removeItem(pendingKey(targetBranchId));
            setCopied(true);
            setNotice(`تأكدنا من نسخ كورس ${course.name} إلى ${branches.find(branch => branch.id === targetBranchId)?.name ?? "الفرع المحدد"}.`);
            router.refresh();
            requestAnimationFrame(() => heading.current?.focus());
            return;
          }
          if (replay.status !== 409) {
            setError("تعذر التحقق من نتيجة النسخ السابقة. حاول مرة أخرى بنفس الفرع.");
            return;
          }
          localStorage.removeItem(pendingKey(targetBranchId));
        }
      }
      const response = await centerRequest(
        `courses/${course.id}/copy-preview?target_branch_id=${targetBranchId}&page=${page}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const data = await response.json() as CopyPreview;
      if (preview?.snapshot_hash !== data.snapshot_hash) setRequestId(newSubmissionId());
      setPreview(data);
      requestAnimationFrame(() => heading.current?.focus());
    } catch { setError("تعذر تحميل معاينة النسخ. حاول مرة أخرى."); }
    finally { setBusy(null); }
  }

  async function copy() {
    if (!preview || busy || copied) return;
    setBusy("copy"); setError(""); setNotice("");
    try {
      const payload = {
        target_branch_id: targetBranchId, snapshot_hash: preview.snapshot_hash, request_id: requestId,
      };
      localStorage.setItem(pendingKey(targetBranchId), JSON.stringify(payload));
      const response = await centerRequest(`courses/${course.id}/copies`, "POST", payload);
      if (!response.ok) {
        const data = await response.clone().json().catch(() => ({}));
        if (response.status === 409) localStorage.removeItem(pendingKey(targetBranchId));
        setError(response.status === 409 && data.code === "curriculum_source_changed"
          ? "تغير منهج المصدر بعد المعاينة. حدّث المعاينة قبل النسخ."
          : await responseMessage(response));
        return;
      }
      localStorage.removeItem(pendingKey(targetBranchId));
      setCopied(true);
      setNotice(`نُسخ كورس ${course.name} إلى ${preview.target.name}. يمكنك إدارة النسخة مستقلة عن المصدر.`);
      router.refresh();
      requestAnimationFrame(() => heading.current?.focus());
    } catch {
      setError("تعذر تأكيد نتيجة النسخ. أعد المحاولة بنفس الطلب، أو افتح المعاينة لنفس الفرع بعد العودة للتحقق من النتيجة.");
    } finally { setBusy(null); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void loadPreview(); }

  return <section className="data-panel form-stack" aria-labelledby="curriculum-copy-title">
    <h2 id="curriculum-copy-title" ref={heading} tabIndex={-1}>نسخ منهج {course.name}</h2>
    <p className="muted">سيُنسخ الكورس ومراحله ومستوياته وجميع إصدارات خططه إلى فرع آخر. لا تُنسخ المجموعات أو الطلاب أو الحضور أو الماليات أو معادلات المحتوى.</p>
    <form id={formId} onSubmit={submit}>
      <FieldGroup><Field><FieldLabel htmlFor="curriculum-copy-target">الفرع الوجهة</FieldLabel>
        <NativeSelect id="curriculum-copy-target" value={targetBranchId} disabled={Boolean(busy) || copied}
          onChange={event => { setTargetBranchId(Number(event.target.value)); setPreview(null); setRequestId(newSubmissionId()); setError(""); }}>
          {branches.map(branch => <NativeSelectOption key={branch.id} value={branch.id}>{branch.name}</NativeSelectOption>)}
        </NativeSelect>
        <FieldDescription>المصدر: {course.name} · {context.branches.find(branch => branch.id === course.branch_id)?.name ?? `فرع #${course.branch_id}`}. سيصبح منهج الوجهة مستقلًا بعد النسخ.</FieldDescription>
      </Field></FieldGroup>
    </form>
    <CenterHeaderActions>
      {!copied ? <Button form={formId} type="submit" busy={busy === "preview"} disabled={Boolean(busy) || !targetBranchId}>
        {preview ? "تحديث المعاينة" : "معاينة ما سيُنسخ"}
      </Button> : null}
      {preview && !copied ? <Button variant="primary" busy={busy === "copy"} disabled={Boolean(busy)} onClick={() => void copy()}>تأكيد النسخ</Button> : null}
      <Button onClick={onClose} disabled={Boolean(busy)}>العودة إلى الكورسات</Button>
    </CenterHeaderActions>
    {error ? <div ref={focusError} tabIndex={-1}><InlineNotice tone="error">{error}</InlineNotice></div> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {preview ? <div className="form-stack" aria-live="polite">
      <p>المصدر: {preview.source.name} · {preview.source.branch_name} ← الوجهة: {preview.target.name}</p>
      <p>{preview.counts.stages.toLocaleString("ar-EG")} مرحلة · {preview.counts.levels.toLocaleString("ar-EG")} مستوى · {preview.counts.plans.toLocaleString("ar-EG")} إصدار خطة · {preview.counts.lectures.toLocaleString("ar-EG")} محاضرة مخططة</p>
      {preview.outline.length ? <ul className="list-disc space-y-1 ps-6">
        {preview.outline.map((item, index) => <li key={`${item.kind}-${item.stage_name ?? ""}-${item.name}-${index}`}>
          {item.kind === "stage" ? `مرحلة: ${item.name}` : `مستوى: ${item.name} · ${item.stage_name} · ${item.plans} إصدار · ${item.lectures} محاضرة`}
        </li>)}
      </ul> : <p>الكورس لا يضم مراحل بعد؛ ستُنسخ بياناته فقط.</p>}
      <CenterHeaderActions>
        {preview.pagination.page > 1 ? <Button disabled={Boolean(busy)} onClick={() => void loadPreview(preview.pagination.page - 1)}>الصفحة السابقة للمعاينة</Button> : null}
        {preview.pagination.has_more ? <Button disabled={Boolean(busy)} onClick={() => void loadPreview(preview.pagination.page + 1)}>الصفحة التالية للمعاينة</Button> : null}
      </CenterHeaderActions>
    </div> : null}
  </section>;
}

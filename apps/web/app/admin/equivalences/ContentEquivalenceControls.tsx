'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { Button } from '@/components/Button';
import { CenterHeaderActions, CenterPageActions } from '@/components/CenterShell';
import { DataTable } from '@/components/DataTable';
import { InlineNotice } from '@/components/InlineNotice';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/FormField';
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { ContentEquivalenceContext, EquivalenceLectureSnapshot, EquivalencePlan } from '@/lib/content-equivalences';

function planLabel(plan: EquivalencePlan) {
  return `${plan.branch_name} · ${plan.course_name} ← ${plan.stage_name} ← ${plan.level_name} · الإصدار ${plan.version.toLocaleString('ar-EG')}`;
}

function approvedLectures(lectures: EquivalenceLectureSnapshot[]) {
  return <details><summary>عرض المحاضرات المعتمدة</summary><ol className='list-decimal ps-6'>
    {lectures.map(lecture => <li key={lecture.number}>{lecture.number.toLocaleString('ar-EG')}: {lecture.content}
      {lecture.title ? ` · ${lecture.title}` : ''}</li>)}
  </ol></details>;
}

export function ContentEquivalenceControls({ context }: { context: ContentEquivalenceContext }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const formId = useId();
  const trigger = useRef<HTMLElement | null>(null);
  const searchRead = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const [editing, setEditing] = useState(false);
  const [options, setOptions] = useState(context.options);
  const [optionsHasMore, setOptionsHasMore] = useState(context.options_has_more);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<EquivalencePlan | null>(null);
  const [target, setTarget] = useState<EquivalencePlan | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const canApprove = (branchId: number) => context.permissions.can_manage_center
    || context.permissions.branch_actions?.[String(branchId)]?.includes('content.equivalence');
  const hasApproverRole = context.permissions.can_manage_center
    || Object.values(context.permissions.branch_actions ?? {}).some(actions => actions.includes('content.equivalence'));
  const dirty = editing && (source !== null || target !== null || sourceIds.length > 0 || targetIds.length > 0 || reason.trim() !== '');

  useEffect(() => () => searchRead.current?.abort(), []);
  function open() {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(true); setSource(null); setTarget(null); setSourceIds([]); setTargetIds([]); setReason('');
    setRequestId(newSubmissionId()); setUncertain(false); setError(''); setNotice(''); setFieldErrors({});
    requestAnimationFrame(() => document.getElementById(`${formId}-source`)?.focus());
  }
  function close() {
    setEditing(false); setUncertain(false); setError(''); setFieldErrors({});
    requestAnimationFrame(() => trigger.current?.isConnected && trigger.current.focus());
  }
  function toggle(ids: string[], setIds: (ids: string[]) => void, id: string, checked: boolean) {
    setIds(checked ? [...ids, id] : ids.filter(value => value !== id));
    setFieldErrors({});
  }
  async function findOptions() {
    searchRead.current?.abort();
    const load = new AbortController();
    searchRead.current = load;
    setSearchBusy(true); setError('');
    try {
      const response = await centerRequest(`content-equivalences?q=${encodeURIComponent(search.trim())}`, 'GET', undefined, load.signal);
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const data = await response.json() as ContentEquivalenceContext;
      if (searchRead.current !== load) return;
      setOptions(data.options); setOptionsHasMore(data.options_has_more);
    } catch { if (searchRead.current === load) setError('تعذر البحث عن إصدارات الخطة. حاول مرة أخرى.'); }
    finally { if (searchRead.current === load) { searchRead.current = null; setSearchBusy(false); } }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (!source || !target) {
      setFieldErrors({ ...(!source ? { source_plan_version_id: 'اختر إصدار المصدر.' } : {}),
        ...(!target ? { target_plan_version_id: 'اختر إصدار الوجهة.' } : {}) });
      setError('اختر إصداري المصدر والوجهة قبل الاعتماد.');
      requestAnimationFrame(() => document.getElementById(`${formId}-${!source ? 'source' : 'target'}`)?.focus());
      return;
    }
    const errors: Record<string, string> = {};
    if (source.id === target.id) errors.target_plan_version_id = 'اختر إصدارًا مختلفًا عن المصدر.';
    if (!canApprove(source.branch_id) || !canApprove(target.branch_id)) errors.scope = 'تحتاج صلاحية اعتماد أكاديمي في فرعي المصدر والوجهة.';
    if (!sourceIds.length) errors.source_lecture_ids = 'اختر محاضرة مصدر كاملة على الأقل.';
    if (!targetIds.length) errors.target_lecture_ids = 'اختر متطلبًا مستهدفًا كاملًا على الأقل.';
    if (reason.trim().length < 5) errors.reason = 'اكتب سبب الاعتماد بخمس حروف على الأقل.';
    if (Object.keys(errors).length) {
      setFieldErrors(errors); setError('راجع اختيار المصدر والمتطلبات والسبب.');
      const firstInvalid = errors.target_plan_version_id ? 'target' : errors.scope ? 'source'
        : errors.source_lecture_ids ? 'source-lecture-0' : errors.target_lecture_ids ? 'target-lecture-0' : 'reason';
      requestAnimationFrame(() => document.getElementById(`${formId}-${firstInvalid}`)?.focus());
      return;
    }
    submitting.current = true; setBusy(true); setError(''); setFieldErrors({});
    try {
      const response = await centerRequest('content-equivalences', 'POST', {
        source_plan_version_id: source.id, target_plan_version_id: target.id,
        source_lecture_ids: sourceIds, target_lecture_ids: targetIds,
        reason: reason.trim(), request_id: requestId,
      });
      if (!response.ok) {
        if (response.status !== 409) setUncertain(false);
        if (response.status === 409) {
          const data = await response.json().catch(() => ({}));
          setError(data.code === 'equivalence_already_approved'
            ? 'هذه المعادلة معتمدة سابقًا. راجع سجل الاعتمادات قبل إنشاء طلب آخر.'
            : 'تغيرت بيانات الطلب بعد محاولة حفظه. ألغِ المسودة وافتح طلبًا جديدًا بعد مراجعة السجل.');
        } else if (response.status === 404) setError('لم يعد أحد الإصدارين متاحًا ضمن فروعك.');
        else { setFieldErrors(await responseFieldErrors(response)); setError(await responseMessage(response)); }
        return;
      }
      close(); setNotice('اعتُمدت المعادلة بين محاضرات كاملة. لم تتغير تغطية الطلاب أو حضورهم تلقائيًا.');
      router.refresh();
    } catch {
      setUncertain(true);
      setError('تعذر تأكيد الحفظ. أعد إرسال الطلب نفسه للتحقق؛ لن ينشأ اعتماد مكرر. يمكنك إلغاء المسودة.');
    } finally { submitting.current = false; setBusy(false); }
  }

  const available = (selected: EquivalencePlan | null) => selected && !options.some(option => option.id === selected.id)
    ? [selected, ...options] : options;
  const pageHref = (page: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (page > 1) params.set('page', String(page)); else params.delete('page');
    return `/admin/equivalences${params.size ? `?${params}` : ''}`;
  };
  return <>
    <CenterPageActions context={context} actions={<><Link href='/admin/curriculum'>العودة إلى المنهج</Link>
      {hasApproverRole && !editing ? <Button variant='primary' onClick={open}>اعتماد معادلة محتوى</Button> : null}</>} />
    <UnsavedChangesGuard dirty={dirty} guardHistory />
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
    {editing ? <form id={formId} onSubmit={save} className='context-card space-y-5'>
      <h2>اعتماد محاضرات بديلة</h2>
      <p className='muted'>حدد كل محاضرات المصدر اللازمة لاستيفاء كل المتطلبات المستهدفة المختارة. لا تمنح الأسماء أو الأرقام أو تساوي الساعات معادلة تلقائية، ولا يُحتسب جزء من محاضرة.</p>
      <div role='search' className='form-actions' onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void findOptions(); } }}>
        <FormField id={`${formId}-search`} label='بحث عن مستوى أو كورس لاختيار الإصدار' value={search} onChange={setSearch} disabled={busy || uncertain} />
        <Button type='button' onClick={findOptions} disabled={searchBusy || busy || uncertain} busy={searchBusy}>بحث عن الإصدارات</Button>
      </div>
      {optionsHasMore ? <p className='muted'>تظهر أول ٣٠ نتيجة فقط؛ ابحث باسم الكورس أو المستوى للوصول لإصدار آخر.</p> : null}
      <div className='form-grid'>
        <Field><FieldLabel htmlFor={`${formId}-source`}>إصدار المصدر</FieldLabel>
          <NativeSelect id={`${formId}-source`} value={source?.id ?? ''} disabled={busy || uncertain} aria-invalid={Boolean(fieldErrors.source_plan_version_id)}
            onChange={event => { setSource(available(source).find(option => option.id === event.target.value) ?? null); setSourceIds([]); setFieldErrors({}); }}>
            <NativeSelectOption value=''>اختر خطة المحاضرات البديلة</NativeSelectOption>
            {available(source).map(option => <NativeSelectOption key={option.id} value={option.id}>{planLabel(option)}</NativeSelectOption>)}
          </NativeSelect></Field>
        <Field><FieldLabel htmlFor={`${formId}-target`}>إصدار المتطلبات المستهدفة</FieldLabel>
          <NativeSelect id={`${formId}-target`} value={target?.id ?? ''} disabled={busy || uncertain} aria-invalid={Boolean(fieldErrors.target_plan_version_id)}
            onChange={event => { setTarget(available(target).find(option => option.id === event.target.value) ?? null); setTargetIds([]); setFieldErrors({}); }}>
            <NativeSelectOption value=''>اختر الخطة المراد استيفاؤها</NativeSelectOption>
            {available(target).map(option => <NativeSelectOption key={option.id} value={option.id}>{planLabel(option)}</NativeSelectOption>)}
          </NativeSelect></Field>
      </div>
      {fieldErrors.scope ? <InlineNotice tone='error'>{fieldErrors.scope}</InlineNotice> : null}
      {source ? <FieldSet><FieldLegend>محاضرات المصدر المطلوبة كلها</FieldLegend>
        <FieldDescription>يجب احتساب حضور كل محاضرة مصدر مختارة قبل أن تستوفي المعادلة متطلبات الوجهة.</FieldDescription>
        {source.lectures.map((lecture, index) => <FieldLabel key={lecture.id} className='flex items-start gap-2'>
          <Checkbox id={`${formId}-source-lecture-${index}`} checked={sourceIds.includes(lecture.id)} disabled={busy || uncertain}
            aria-invalid={Boolean(fieldErrors.source_lecture_ids)} onCheckedChange={value => toggle(sourceIds, setSourceIds, lecture.id, Boolean(value))} />
          <span>المحاضرة {lecture.number.toLocaleString('ar-EG')}: {lecture.content}{lecture.title ? ` · ${lecture.title}` : ''}</span>
        </FieldLabel>)}
        {fieldErrors.source_lecture_ids ? <InlineNotice tone='error'>{fieldErrors.source_lecture_ids}</InlineNotice> : null}
      </FieldSet> : null}
      {target ? <FieldSet><FieldLegend>المتطلبات المستهدفة كاملة</FieldLegend>
        <FieldDescription>كل متطلب محدد يُستوفى كاملًا، دون كسور أو احتساب مكرر.</FieldDescription>
        {target.lectures.map((lecture, index) => <FieldLabel key={lecture.id} className='flex items-start gap-2'>
          <Checkbox id={`${formId}-target-lecture-${index}`} checked={targetIds.includes(lecture.id)} disabled={busy || uncertain}
            aria-invalid={Boolean(fieldErrors.target_lecture_ids)} onCheckedChange={value => toggle(targetIds, setTargetIds, lecture.id, Boolean(value))} />
          <span>المحاضرة {lecture.number.toLocaleString('ar-EG')}: {lecture.content}{lecture.title ? ` · ${lecture.title}` : ''}</span>
        </FieldLabel>)}
        {fieldErrors.target_lecture_ids ? <InlineNotice tone='error'>{fieldErrors.target_lecture_ids}</InlineNotice> : null}
      </FieldSet> : null}
      <Field><FieldLabel htmlFor={`${formId}-reason`}>سبب الاعتماد</FieldLabel>
        <Textarea id={`${formId}-reason`} value={reason} disabled={busy || uncertain} required minLength={5} maxLength={1000}
          aria-invalid={Boolean(fieldErrors.reason)} onChange={event => { setReason(event.target.value); setFieldErrors({}); }} />
        {fieldErrors.reason ? <InlineNotice tone='error'>{fieldErrors.reason}</InlineNotice> : null}
      </Field>
      <CenterHeaderActions><Button type='submit' form={formId} variant='primary' disabled={busy} busy={busy}>{uncertain ? 'التحقق من الحفظ' : 'اعتماد المعادلة'}</Button>
        <Button type='button' disabled={busy} onClick={close}>إلغاء</Button></CenterHeaderActions>
    </form> : null}
    <DataTable id='content-equivalence-history' title='سجل اعتمادات معادلة المحتوى'
      description='كل اعتماد يحفظ إصداري المصدر والوجهة ومحاضراتهما الكاملة والسبب وصاحب الاعتماد. تطبيقه على تغطية دراسة قائمة إجراء منفصل.'
      rows={context.approvals} rowKey={row => row.id} pageSize={20}
      serverPagination={{ page: context.pagination.page, hasMore: context.pagination.has_more, batchSize: 20,
        previousHref: pageHref(context.pagination.page - 1), nextHref: pageHref(context.pagination.page + 1) }}
      searchText={row => `${row.source_level_name} ${row.target_level_name} ${row.reason} ${row.approved_by_name}`}
      emptyMessage='لا توجد معادلات معتمدة ضمن فروعك.' columns={[
        { key: 'source', label: 'المصدر', render: row => <div>{row.source_level_name} · الإصدار {row.source_version.toLocaleString('ar-EG')} · {row.source_lecture_ids.length.toLocaleString('ar-EG')} محاضرة{approvedLectures(row.source_lectures)}</div> },
        { key: 'target', label: 'الوجهة', render: row => <div>{row.target_level_name} · الإصدار {row.target_version.toLocaleString('ar-EG')} · {row.target_lecture_ids.length.toLocaleString('ar-EG')} متطلب{approvedLectures(row.target_lectures)}</div> },
        { key: 'reason', label: 'سبب الاعتماد', render: row => row.reason },
        { key: 'actor', label: 'اعتمدها', render: row => row.approved_by_name },
        { key: 'date', label: 'التاريخ', render: row => new Date(row.approved_at.replace(' ', 'T') + 'Z').toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' }) },
      ]} />
  </>;
}

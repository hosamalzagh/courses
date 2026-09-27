'use client';
import { useRef, useState } from 'react';
import { ChoiceField } from './ChoiceField';
import { Button } from './Button';
import { InlineNotice } from './InlineNotice';
import { FormField } from './FormField';
import { centerRequest, responseMessage } from '@/lib/client-api';
import { studentChoiceLabels } from '@/lib/student-profile-choices';
import type { Student, StudentChoiceKind, StudentChoiceList, StudentContext, StudentGeneralData, StudentChoiceContext } from '@/lib/server-context';

export function StudentChoiceFields({ prefix, context, student, data, onChange, errors, disabled }: {
  prefix: string; context: StudentContext; student?: Student; data: StudentGeneralData;
  onChange: (key: keyof StudentGeneralData, value: string) => void; errors: Record<string, string>; disabled: boolean;
}) {
  return <div className='student-fields'>{(Object.keys(studentChoiceLabels) as StudentChoiceKind[]).map(kind => <StudentChoiceField key={`${kind}:${student?.revision ?? 0}`} prefix={prefix} kind={kind} initial={context.profile_choice_lists[kind]} selected={student?.profile_choices[kind]} value={data[`${kind}_id`] ?? ''} onChange={value => onChange(`${kind}_id`, value)} error={errors[`${kind}_id`]} disabled={disabled} />)}</div>;
}
function StudentChoiceField({ prefix, kind, initial, selected, value, onChange, error, disabled }: {
  prefix: string; kind: StudentChoiceKind; initial: StudentChoiceList; selected?: Student['profile_choices'][StudentChoiceKind];
  value: string; onChange: (value: string) => void; error?: string; disabled: boolean;
}) {
  const [list, setList] = useState(initial);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const loading = useRef(false);
  const [failure, setFailure] = useState('');
  const label = studentChoiceLabels[kind];
  const choices = selected ? [selected, ...list.choices.filter(choice => choice.id !== selected.id)] : list.choices;
  async function load(page: number) {
    if (loading.current) return;
    loading.current = true; setBusy(true); setFailure('');
    try {
      const response = await centerRequest(`student-profile-choices?${new URLSearchParams({ kind, page: String(page), q: query })}`, 'GET');
      if (!response.ok) { setFailure(await responseMessage(response)); return; }
      const result = await response.json() as StudentChoiceContext;
      setList({ ...result.pagination, choices: page === 1 ? result.choices : [...list.choices, ...result.choices.filter(choice => !list.choices.some(item => item.id === choice.id))] });
    } catch { setFailure('تعذر تحميل الاختيارات. القيمة والمدخلات محفوظة؛ أعد المحاولة.'); }
    finally { loading.current = false; setBusy(false); }
  }
  // Keep a chosen value visible when searching or paging, even outside the loaded page.
  const [current, setCurrent] = useState(selected);
  const visible = value && current?.id === value && !choices.some(choice => choice.id === value) ? [current, ...choices] : choices;
  return <div className='form-stack'>
    <ChoiceField id={`${prefix}-${kind}`} label={label} value={value} onChange={value => { setCurrent(choices.find(choice => choice.id === value)); onChange(value); }} error={error} disabled={disabled || busy} items={[{ value: '', label: 'لم يُحدد' }, ...visible.map(choice => ({ value: choice.id, label: `${choice.label}${choice.active ? '' : ' — معطل'}`, disabled: !choice.active }))]} />
    {initial.has_more || list.has_more || query ? <><FormField id={`${prefix}-${kind}-search`} label={`البحث في ${label}`} value={query} onChange={setQuery} /><Button disabled={disabled} busy={busy} onClick={() => load(1)}>بحث في {label}</Button></> : null}
    {list.has_more ? <Button disabled={disabled} busy={busy} onClick={() => load(list.page + 1)}>تحميل المزيد من {label}</Button> : null}
    {failure ? <InlineNotice tone='error'>{failure}</InlineNotice> : null}
  </div>;
}

'use client';
import { useEffect, useRef } from 'react';
import { Field, FieldLabel, FieldError } from './ui/field';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from './ui/select';

export function ChoiceField({ id, label, value, onChange, items, error, disabled = false }: {
  id: string; label: string; value: string; onChange: (value: string) => void;
  items: { value: string; label: string; disabled?: boolean }[]; error?: string; disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = trigger.current;
    if (error && element && element.form?.querySelector('[aria-invalid="true"]') === element) element.focus();
  }, [error]);
  return <Field data-invalid={Boolean(error)}>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Select value={value} onValueChange={(value) => onChange(String(value ?? ''))} items={items} disabled={disabled}>
      <SelectTrigger ref={trigger} id={id} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value} disabled={item.disabled}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
    {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
  </Field>;
}

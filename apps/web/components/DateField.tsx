"use client";

import { useEffect, useRef, useState } from "react";
import { format, isValid, parseISO } from "date-fns";
import { arSA } from "react-day-picker/locale";
import { CalendarDaysIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  autoComplete?: string;
  focusOnMount?: boolean;
  maxDate?: Date;
};

function selectedDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = parseISO(value);
  return isValid(date) && format(date, "yyyy-MM-dd") === value ? date : undefined;
}

export function DateField({ id, label, value, onChange, error, hint, disabled = false, required = false, autoComplete, focusOnMount = false, maxDate }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const selected = selectedDate(value);

  useEffect(() => {
    if (!focusOnMount) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, [focusOnMount]);
  useEffect(() => {
    const input = inputRef.current;
    if (error && input && input.form?.querySelector('[aria-invalid="true"]') === input) input.focus();
  }, [error]);

  return <Field data-invalid={Boolean(error)} data-disabled={disabled}>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <InputGroup>
      <InputGroupInput ref={inputRef} id={id} name={id} type="text" dir="ltr" autoComplete={autoComplete} placeholder="YYYY-MM-DD" value={value} disabled={disabled} required={required} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} onChange={(event) => onChange(event.target.value)} />
      <InputGroupAddon align="inline-end">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<InputGroupButton type="button" size="icon-xs" aria-label={`اختيار ${label}`} disabled={disabled} />}><CalendarDaysIcon /></PopoverTrigger>
          <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
            <PopoverTitle className="sr-only">اختيار {label}</PopoverTitle>
            <Calendar mode="single" locale={arSA} dir="rtl" formatters={{ formatWeekdayName: (date) => ["أح", "إث", "ثل", "أر", "خم", "جم", "سب"][date.getDay()] }} selected={selected} defaultMonth={selected ?? maxDate ?? new Date()} captionLayout="dropdown" startMonth={new Date(1900, 0)} endMonth={maxDate ?? new Date(2100, 11)} disabled={maxDate ? (date) => date > maxDate : undefined} onSelect={(date) => {
              if (!date) return;
              onChange(format(date, "yyyy-MM-dd"));
              setOpen(false);
              requestAnimationFrame(() => inputRef.current?.focus());
            }} />
          </PopoverContent>
        </Popover>
      </InputGroupAddon>
    </InputGroup>
    {hint && !error ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
    {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
  </Field>;
}

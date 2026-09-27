"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";

type Props = {
  id: string; label: string; value: string; onChange: (value: string) => void;
  type?: string; autoComplete?: string; required?: boolean; hint?: string;
  error?: string; direction?: "ltr" | "rtl"; focusOnMount?: boolean;
};

export function FormField({ id, label, value, onChange, type = "text", autoComplete, required, hint, error, direction, focusOnMount = false }: Props) {
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
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
  const props = {
    ref: inputRef, id, name: id, type: type === "password" && visible ? "text" : type,
    value, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    autoComplete, required, "aria-invalid": Boolean(error),
    "aria-describedby": error ? `${id}-error` : hint ? `${id}-hint` : undefined, dir: direction,
  };
  return <Field data-invalid={Boolean(error)}>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    {type === "password" ? <InputGroup>
      <InputGroupInput {...props} />
      <InputGroupAddon align="inline-end"><InputGroupButton type="button" aria-label={`${visible ? "إخفاء" : "إظهار"} ${label}`} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? "إخفاء" : "إظهار"}</InputGroupButton></InputGroupAddon>
    </InputGroup> : <Input {...props} />}
    {hint && !error ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
    {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
  </Field>;
}

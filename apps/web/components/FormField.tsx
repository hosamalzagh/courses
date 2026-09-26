"use client";

import { useEffect, useRef } from "react";
type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  direction?: "ltr" | "rtl";
  focusOnMount?: boolean;
};

export function FormField({ id, label, value, onChange, type = "text", autoComplete, required, hint, error, direction, focusOnMount = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, [focusOnMount]);
  useEffect(() => {
    const input = inputRef.current;
    if (error && input && input.form?.querySelector("[aria-invalid=\"true\"]") === input) input.focus();
  }, [error]);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        dir={direction}
      />
      {hint && !error ? <span id={`${id}-hint`} className="field-hint">{hint}</span> : null}
      {error ? <span id={`${id}-error`} className="field-error">{error}</span> : null}
    </div>
  );
}

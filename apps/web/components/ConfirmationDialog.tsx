"use client";

import { Button } from "@/components/Button";
import { useEffect, useRef } from "react";

type Props = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmationDialog({ title, description, confirmLabel, onConfirm, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-description" onCancel={onCancel}>
    <h2 id="confirmation-title">{title}</h2>
    <p id="confirmation-description">{description}</p>
    <div className="member-actions">
      <Button ref={cancelRef} variant="secondary" type="button" onClick={onCancel}>إلغاء</Button>
      <Button variant="danger" type="button" onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  </dialog>;
}

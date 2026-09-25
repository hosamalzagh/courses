"use client";

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
    return () => {
      dialog?.close();
      previousFocus?.focus();
    };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-description" onCancel={onCancel}>
    <h2 id="confirmation-title">{title}</h2>
    <p id="confirmation-description">{description}</p>
    <div className="member-actions">
      <button ref={cancelRef} className="button button-secondary" type="button" onClick={onCancel}>إلغاء</button>
      <button className="button button-primary" type="button" onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </dialog>;
}

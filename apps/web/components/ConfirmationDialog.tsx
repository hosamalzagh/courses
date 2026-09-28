"use client";

import { useRef } from "react";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";

type Props = {
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm?: () => void;
  onCancel: () => void;
  cancelLabel?: string;
};

export function ConfirmationDialog({ title, description, confirmLabel, onConfirm, onCancel, cancelLabel = "إلغاء" }: Props) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <AlertDialogContent initialFocus={cancel}>
      <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel ref={cancel}>{cancelLabel}</AlertDialogCancel>
        {confirmLabel && onConfirm ? <AlertDialogAction variant="destructive" onClick={onConfirm}>{confirmLabel}</AlertDialogAction> : null}
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

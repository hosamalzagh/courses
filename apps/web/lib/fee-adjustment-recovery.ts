export type PendingFeeAdjustment = {
  fee_id: string;
  new_due: string;
  reason: string;
  replaces_adjustment_id: string | null;
  version: string;
  request_id: string;
};

export function feeAdjustmentRecoveryKey(centerId: string, actorId: number, studentId: string): string {
  return `courses:fee-adjustment:${centerId}:${actorId}:${studentId}`;
}

export function readPendingFeeAdjustment(key: string): PendingFeeAdjustment | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const pending = value as Record<string, unknown>;
    if (typeof pending.fee_id !== "string" || typeof pending.new_due !== "string" ||
      typeof pending.reason !== "string" || typeof pending.version !== "string" ||
      typeof pending.request_id !== "string" ||
      !(pending.replaces_adjustment_id === null || typeof pending.replaces_adjustment_id === "string")) return null;
    return pending as PendingFeeAdjustment;
  } catch { return null; }
}

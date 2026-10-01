"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink } from "@/components/PrefetchLink";
import { centerRequest, responseMessage } from "@/lib/client-api";
import type { WorkspaceOptionsContext } from "@/lib/server-context";
import { workspaceSection } from "@/lib/workspace";

export function WorkspacePicker({ context, returnTo, expired }: { context: WorkspaceOptionsContext; returnTo: string; expired: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const choosing = useRef(false);
  async function choose(mode: "branch" | "center", branchId?: number) {
    if (choosing.current) return;
    choosing.current = true; setBusy(branchId ? String(branchId) : "center"); setError("");
    try {
      const response = await centerRequest("workspaces", "POST", { mode, branch_id: branchId, return_to: workspaceSection(returnTo) });
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const data: { destination: string } = await response.json();
      router.replace(data.destination);
    } catch { setError("تعذر اختيار مساحة العمل. تحقق من الاتصال وحاول مرة أخرى."); }
    finally { choosing.current = false; setBusy(null); }
  }
  const pageHref = (page: number) => `/admin/workspaces?${new URLSearchParams({ page: String(page), return_to: workspaceSection(returnTo) })}`;
  return <Card className="mx-auto w-full max-w-2xl">
    <CardHeader><CardTitle>أين تريد العمل؟</CardTitle><CardDescription>اختر فرعًا من الفروع المتاحة لك.</CardDescription></CardHeader>
    <CardContent className="grid gap-4">
      {expired ? <InlineNotice tone="warning">لم تعد مساحة العمل السابقة متاحة. اختر مساحة متاحة لك.</InlineNotice> : null}
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <div className="grid gap-2" aria-label="الفروع المتاحة">
        {context.branches.map(branch => <Button key={branch.id} className="h-auto min-h-11 justify-between whitespace-normal text-start" busy={busy === String(branch.id)} busyLabel="جارٍ الدخول…" disabled={busy !== null} onClick={() => void choose("branch", branch.id)}>
          <span className="break-words">{branch.name}</span><span aria-hidden="true">←</span>
        </Button>)}
      </div>
      {!context.branches.length && context.pagination.page === 1 ? <InlineNotice>لا توجد فروع متاحة لك.{context.permissions.can_manage_center ? " افتح إدارة المركز لإضافة أول فرع." : " اطلب من مسؤول المركز إسناد صلاحية عرض فرع لك."}</InlineNotice> : null}
      {context.permissions.can_manage_center ? <Button disabled={busy !== null} busy={busy === "center"} busyLabel="جارٍ الدخول…" onClick={() => void choose("center")}>إدارة المركز</Button> : null}
      {context.pagination.page > 1 || context.pagination.has_more ? <nav className="flex flex-wrap gap-4" aria-label="صفحات الفروع المتاحة">
        {context.pagination.page > 1 ? <PrefetchLink className="text-link" href={pageHref(context.pagination.page - 1)}>الفروع السابقة</PrefetchLink> : null}
        {context.pagination.has_more ? <PrefetchLink className="text-link" href={pageHref(context.pagination.page + 1)}>الفروع التالية</PrefetchLink> : null}
      </nav> : null}
    </CardContent>
  </Card>;
}

import { BranchWorkspace } from "./BranchWorkspace";
import { loadCenterContext } from "@/lib/server-context";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const context = await loadCenterContext();

  if (context === "forbidden") {
    return <main className="state-page"><div><span className="eyebrow">صلاحية الوصول</span><h1>هذه الصفحة خارج صلاحيتك</h1><p className="muted">تحقق من حالة عضويتك لدى مالك المركز أو مسؤوله.</p><a className="button button-secondary" href="/login">العودة إلى الدخول</a></div></main>;
  }
  if (context === "unavailable") {
    return <main className="state-page"><div><span className="eyebrow">حالة المركز</span><h1>المركز غير متاح الآن</h1><p className="muted">قد يكون المركز موقوفًا أو يجري تجهيزه. حاول لاحقًا أو تواصل مع مالك المركز.</p><a className="button button-secondary" href="/login">العودة إلى الدخول</a></div></main>;
  }

  return <BranchWorkspace context={context} />;
}

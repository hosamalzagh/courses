import { PrefetchLink } from "./PrefetchLink";
import { buttonVariants } from "@/components/ui/button";
import type { CenterAccessFailure } from "@/lib/server-context";

const content = {
  instructor_unavailable: { eyebrow: "ملف المحاضر", title: "ملف المحاضر غير متاح", detail: "لا يوجد ملف متاح بهذا الرابط ضمن نطاق صلاحيتك في المركز." },
  curriculum_unavailable: { eyebrow: "المنهج", title: "سجل المنهج غير متاح", detail: "لا يوجد سجل متاح بهذا الرابط ضمن نطاق صلاحيتك في المركز. قد يكون قد حُذف." },
  student_unavailable: { eyebrow: "ملف الطالب", title: "ملف الطالب غير متاح", detail: "لا يوجد ملف متاح بهذا الرابط ضمن نطاق صلاحيتك في المركز." },
  forbidden: { eyebrow: "صلاحية الوصول", title: "هذه الصفحة خارج صلاحيتك", detail: "تحقق من صلاحياتك لدى مالك المركز أو مسؤوله." },
  suspended: { eyebrow: "حالة العضوية", title: "أُوقفت عضويتك في هذا المركز", detail: "تواصل مع مالك المركز أو مسؤوله لاستعادة الوصول." },
  unavailable: { eyebrow: "حالة المركز", title: "المركز غير متاح الآن", detail: "قد يكون المركز موقوفًا أو يجري تجهيزه. حاول لاحقًا أو تواصل مع مالك المركز." },
} satisfies Record<CenterAccessFailure, { eyebrow: string; title: string; detail: string }>;

const returnLinks: Partial<Record<CenterAccessFailure, { href: string; label: string }>> = {
  curriculum_unavailable: { href: "/admin/curriculum", label: "العودة إلى المناهج والخطط" },
  student_unavailable: { href: "/admin/students", label: "العودة إلى ملفات الطلاب" },
  instructor_unavailable: { href: "/admin/instructors", label: "العودة إلى ملفات المحاضرين" },
};

export function CenterAccessState({ state }: { state: CenterAccessFailure }) {
  const { eyebrow, title, detail } = content[state];
  const returnLink = returnLinks[state] ?? { href: "/login", label: "العودة إلى الدخول" };

  return <main className="state-page"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p className="muted">{detail}</p><PrefetchLink className={buttonVariants({ variant: "outline" })} href={returnLink.href}>{returnLink.label}</PrefetchLink></div></main>;
}

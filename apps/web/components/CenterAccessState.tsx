import type { CenterAccessFailure } from "@/lib/server-context";

const content = {
  student_unavailable: { eyebrow: "ملف الطالب", title: "ملف الطالب غير متاح", detail: "لا يوجد ملف متاح بهذا الرابط ضمن نطاق صلاحيتك في المركز." },
  forbidden: { eyebrow: "صلاحية الوصول", title: "هذه الصفحة خارج صلاحيتك", detail: "تحقق من صلاحياتك لدى مالك المركز أو مسؤوله." },
  suspended: { eyebrow: "حالة العضوية", title: "أُوقفت عضويتك في هذا المركز", detail: "تواصل مع مالك المركز أو مسؤوله لاستعادة الوصول." },
  unavailable: { eyebrow: "حالة المركز", title: "المركز غير متاح الآن", detail: "قد يكون المركز موقوفًا أو يجري تجهيزه. حاول لاحقًا أو تواصل مع مالك المركز." },
} satisfies Record<CenterAccessFailure, { eyebrow: string; title: string; detail: string }>;

export function CenterAccessState({ state }: { state: CenterAccessFailure }) {
  const { eyebrow, title, detail } = content[state];

  return <main className="state-page"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p className="muted">{detail}</p><a className="button button-secondary" href={state === "student_unavailable" ? "/admin/students" : "/login"}>{state === "student_unavailable" ? "العودة إلى ملفات الطلاب" : "العودة إلى الدخول"}</a></div></main>;
}

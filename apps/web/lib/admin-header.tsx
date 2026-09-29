import type { ReactNode } from "react";
import type { CenterContext } from "./server-context";

// One source for the server header and the interactive workspace header.
export function getAdminHeader(path: string, context: CenterContext): { title: string; description: ReactNode } {
  const headers: Record<string, { title: string; description: ReactNode }> = {
    "/admin": { title: "الرئيسية", description: "" },
    "/admin/student-search": { title: 'البحث في طلاب المركز', description: 'الاسم ورقم الطالب ورقم التواصل فقط. لا يمنح هذا البحث قراءة الدراسة أو الحساب المالي أو تعديل الملفات خارج فروعك.' },
    "/admin/student-custom-fields": {title:"الحقول الإضافية للطالب",description:"حقول عامة مشتركة بين فروع المركز، مع ترتيب العرض والإلزام."},
    "/admin/student-profile-choices": { title: "قوائم بيانات الطالب", description: "اختيارات مشتركة بين فروع المركز. التعطيل يحفظ استعمالات الملفات السابقة." },
    "/admin/settings": { title: "الإعدادات", description: "إدارة المركز والفروع وإعدادات الطلاب وأمان الحساب من مكان واحد." },
    "/admin/curriculum": { title: "منهج الفرع", description: 'كورس ← مرحلة دراسية ← مستوى. كل فرع يحفظ منهجه مستقلًا، والساعات المخططة منفصلة عن عدد المحاضرات.' },
    "/admin/equivalences": { title: "معادلة المحتوى", description: "اعتماد صريح لمحاضرات بديلة تستوفي متطلبات كاملة بين إصدارات خطط مختلفة، بسبب وهوية وتاريخ محفوظين." },
    "/admin/groups": { title: "المجموعات الدراسية", description: 'كل مجموعة ترتبط بإصدار خطة محدد، ولها محاضرون وسعر وحالة تشغيل مستقلة.' },
    "/admin/absence-review": { title: "مراجعة الغياب", description: "يعرض الغياب النهائي المستحق وفق قاعدة المجموعة الموروثة. القرار بشأن الطالب إجراء يدوي." },
    "/admin/security": { title: "التحقق بخطوتين", description: <>حسابك <bdi dir="ltr">{context.user.email}</bdi> مشترك بين المراكز. التفعيل اختياري ويطبق على دخولك إلى جميعها.</> },
    "/admin/instructors": { title: 'ملفات المحاضرين', description: 'ملف واحد داخل المركز، دون حساب دخول. يمكن إعادة استخدامه في الفروع المصرح بها مع بقاء سجلات التدريس داخل نطاق كل فرع.' },
    "/admin/students": { title: 'ملفات الطلاب', description: 'ملف واحد داخل المركز، دون حساب دخول. رقم الطالب ثابت ورقم التواصل يمكن مشاركته.' },
    "/admin/audit": { title: "سجل التدقيق", description: "آخر 50 تغييرًا ضمن نطاق صلاحيتك. التوقيت بتوقيت القاهرة." },
    "/admin/members": { title: "موظفو المركز", description: "الدعوات والعضويات وأدوار كل فرع." },
  };
  if (path.startsWith("/admin/curriculum/")) return { ...headers["/admin/curriculum"], title: "خطة المستوى" };
  if (/^\/admin\/groups\/[^/]+\/sessions$/.test(path)) return { title: "جدول محاضرات المجموعة", description: "مواعيد المجموعة مرقمة ومرتبطة بمحاضرات إصدار الخطة المعتمد. التوقيت بتوقيت القاهرة." };
  if (/^\/admin\/groups\/[^/]+\/coverage$/.test(path)) return { title: "تغطية المحتوى وأهلية الإتمام", description: "المحاضرات المطلوبة المستوفاة منفصلة عن انتظام الطالب منذ انضمامه. بلوغ الحد يؤهل للمراجعة ولا يعتمد الإتمام تلقائيًا." };
  if (/^\/admin\/groups\/[^/]+\/sessions\/[^/]+\/attendance$/.test(path)) return { title: "كشف حضور المحاضرة", description: "الحضور غير المسجل يبقى معلقًا حتى إغلاق المحاضرة، ثم يعتمد غياب المستحقين فقط." };
  if (/^\/admin\/groups\/[^/]+\/sessions\/[^/]+\/teaching$/.test(path)) return { title: "التدريس الفعلي للمحاضرة", description: "سجّل من درّس ومدة كل محاضر، سواء بالتتابع أو في الوقت نفسه. سجل الطالب لا يُوزن بالدقائق." };
  if (path === "/admin/students/new") return { title: 'إنشاء ملف طالب', description: 'ابدأ بالاسم وفرع مصرح به، ثم استكمل البيانات الاختيارية.' };
  if (/^\/admin\/students\/[^/]+\/report$/.test(path)) return { title: 'تقرير الطالب', description: 'ملخص بيانات الطالب ودراسته الحالية وغيابه الحالي ضمن فروع صلاحيتك.' };
  if (path.endsWith('/account') && path.startsWith('/admin/students/')) return { title: 'حساب الطالب', description: 'الدفعات المقدمة غير مخصصة لمجموعة بعد. المبالغ المعروضة ضمن فروع صلاحيتك فقط.' };
  if (/^\/admin\/students\/[^/]+\/courses\/[^/]+\/completion$/.test(path)) return { title: 'حالة إتمام الكورس', description: 'يلزم اعتماد إتمام كل مستوى مطلوب على حدة. الإتمام الدراسي لا يعني نجاح امتحان أو إصدار شهادة.' };
  if (path.endsWith('/enrollments') && path.startsWith('/admin/students/')) return { title: 'تسجيل الطالب', description: 'محاولات الدراسة ورسومها حسب فروع صلاحيتك، دون تخصيص الدفعات تلقائيًا.' };
  if (path.startsWith("/admin/students/")) return { title: path.endsWith('/edit') ? 'تعديل بيانات الطالب' : 'ملف الطالب', description: headers["/admin/students"].description };
  if (path.startsWith("/admin/instructors/")) return headers["/admin/instructors"];
  return headers[path] ?? headers["/admin"];
}

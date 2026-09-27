"use client";

import { Button } from "@/components/Button";


import { InlineNotice } from "@/components/InlineNotice";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="state-page"><div><h1>تعذر تحميل المركز</h1><InlineNotice tone="error">لم نتمكن من عرض البيانات الآن. حاول مرة أخرى.</InlineNotice><Button type="submit" variant="primary" onClick={reset}>إعادة المحاولة</Button></div></main>;
}

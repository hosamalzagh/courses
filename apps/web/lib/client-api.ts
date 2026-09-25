export async function centerRequest(path: string, method: "GET" | "POST" | "PATCH" | "PUT", body?: object): Promise<Response> {
  if (method !== "GET") {
    await fetch("/sanctum/csrf-cookie", { credentials: "same-origin", cache: "no-store" });
  }

  const xsrf = document.cookie.split("; ").find((part) => part.startsWith("XSRF-TOKEN="))?.split("=")[1];

  const response = await fetch(`/api/v1/center/${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(xsrf ? { "X-XSRF-TOKEN": decodeURIComponent(xsrf) } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && !path.startsWith("auth/")) {
    window.location.replace("/login?expired=1");
  }
  if (response.status === 403 && !path.startsWith("auth/") &&
    (await response.clone().json().catch(() => ({}))).code === "membership_suspended") {
    window.location.replace("/admin");
  }
  if (response.status === 423 || response.status === 503) {
    window.location.replace("/admin");
  }

  return response;
}

export async function responseMessage(response: Response): Promise<string> {
  if (response.status === 419) return "انتهت صلاحية الجلسة. أعد تحميل الصفحة وحاول مرة أخرى.";
  if (response.status === 401) return "انتهت جلسة الدخول. سجّل الدخول من جديد.";
  if (response.status === 403) {
    const data = await response.clone().json().catch(() => ({}));
    return data.code === "membership_suspended"
      ? "أُوقفت عضويتك في هذا المركز. تواصل مع مالك المركز أو مسؤوله."
      : "هذه العملية خارج صلاحيتك في هذا المركز.";
  }
  if (response.status === 409) {
    const data = await response.clone().json().catch(() => ({}));
    if (data.code === "invitation_delivery_uncertain") {
      return "حالة إرسال الدعوة غير مؤكدة. اطلب من دعم المنصة التحقق من البريد قبل إعادة الإرسال.";
    }
    if (data.message === "Multiple accounts use this email. Contact platform support.") {
      return "يوجد أكثر من حساب لهذا البريد. تواصل مع دعم المنصة لحل تعارض الحسابات.";
    }
  }
  if (response.status === 410) return "انتهت صلاحية الدعوة أو استُخدمت بالفعل.";
  if (response.status === 429) return "تجاوزت عدد المحاولات المسموح. انتظر قليلًا ثم حاول مرة أخرى.";
  if (response.status === 422) {
    const data = await response.json().catch(() => ({}));
    if (data.code === "invalid_reset_link") return "انتهت صلاحية رابط الاستعادة أو استُخدم بالفعل. اطلب رابطًا جديدًا.";
    if (data.message === "Invalid credentials.") return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
    if (data.message === "Existing account password is incorrect.") return "كلمة مرور الحساب الموجود غير صحيحة.";
    return typeof data.message === "string" && /[\u0600-\u06ff]/.test(data.message)
      ? data.message : "راجع البيانات المدخلة ثم حاول مرة أخرى.";
  }
  return "تعذر إكمال العملية. حاول مرة أخرى.";
}

export async function responseFieldErrors(response: Response): Promise<Record<string, string>> {
  if (response.status !== 422) return {};
  const data = await response.clone().json().catch(() => ({}));
  if (!data.errors || typeof data.errors !== "object") return {};
  return Object.fromEntries(Object.entries(data.errors)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0)
    .map(([field, messages]) => [field, /[\u0600-\u06ff]/.test(messages[0]) ? messages[0] : "راجع قيمة هذا الحقل ثم حاول مرة أخرى."]));
}

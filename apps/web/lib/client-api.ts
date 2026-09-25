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
  if (response.status === 423 || response.status === 503) {
    window.location.replace("/admin");
  }

  return response;
}

export async function responseMessage(response: Response): Promise<string> {
  if (response.status === 419) return "انتهت صلاحية الجلسة. أعد تحميل الصفحة وحاول مرة أخرى.";
  if (response.status === 401) return "انتهت جلسة الدخول. سجّل الدخول من جديد.";
  if (response.status === 403) return "هذه العملية خارج صلاحيتك في هذا المركز.";
  if (response.status === 410) return "انتهت صلاحية الدعوة أو استُخدمت بالفعل.";
  if (response.status === 422) {
    const data = await response.json().catch(() => ({}));
    return typeof data.message === "string" && data.message !== "The given data was invalid."
      ? data.message
      : "راجع البيانات المدخلة ثم حاول مرة أخرى.";
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

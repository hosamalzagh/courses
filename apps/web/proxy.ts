import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/admin/student-search") {
    const destination = request.nextUrl.clone();
    const settings = destination.searchParams.get("tab") === "settings";
    destination.pathname = settings ? "/admin/settings" : "/admin/students";
    destination.search = "";
    if (settings) destination.searchParams.set("tab", "students");
    if (!settings) destination.searchParams.set("scope", "center");
    for (const key of ["q", "page", "workspace"]) {
      const value = request.nextUrl.searchParams.get(key);
      if (value !== null) destination.searchParams.set(key, value);
    }
    return NextResponse.redirect(destination);
  }
  const requestHeaders = new Headers(request.headers);
  // Overwrite any client-supplied value. This header is forwarded only to Next.js.
  requestHeaders.set("x-courses-admin-url", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = { matcher: "/admin/:path*" };

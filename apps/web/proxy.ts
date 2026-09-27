import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  // Overwrite any client-supplied value. This header is forwarded only to Next.js.
  requestHeaders.set("x-courses-admin-url", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = { matcher: "/admin/:path*" };

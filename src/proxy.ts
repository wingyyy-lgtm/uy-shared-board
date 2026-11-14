import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Shared-password gate (HTTP Basic, any username) so a public deployment cannot be
// used to spend the model API quota. Set ACCESS_CODE in the hosting environment.
// Unset outside development means closed, not open.
export function proxy(request: NextRequest) {
  const code = process.env.ACCESS_CODE;
  if (!code) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("ACCESS_CODE is not configured.", { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      if (decoded.slice(decoded.indexOf(":") + 1) === code) return NextResponse.next();
    } catch { /* malformed credentials fall through to the challenge */ }
  }
  return new NextResponse("需要访问码。", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="AI Council", charset="UTF-8"' },
  });
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};

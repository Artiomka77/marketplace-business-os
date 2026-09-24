import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "avorofin_local_auth";

function encodeBase64Url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

async function signPayload(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );

  return encodeBase64Url(signature);
}

async function verifyToken(token: string | undefined, secret: string) {
  if (!token || !secret) return false;

  const [payload, signature] = token.split(".");

  if (!payload || !signature) return false;

  const expectedSignature = await signPayload(payload, secret);

  if (signature !== expectedSignature) return false;

  try {
    const data = JSON.parse(
      atob(payload.replaceAll("-", "+").replaceAll("_", "/"))
    );

    return Number(data.exp || 0) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function isPublicPath(pathname: string) {
  return (
    pathname === "/login" ||
    pathname.startsWith("/api/local-auth/login") ||
    pathname.startsWith("/api/telegram") ||
    pathname.startsWith("/api/telegram-bot") ||
    pathname.startsWith("/api/tg") ||
    pathname.startsWith("/api/bot") ||
    pathname.startsWith("/api/finance-bot") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/robots.txt") ||
    pathname.startsWith("/sitemap.xml") ||
    pathname.startsWith("/images") ||
    pathname.startsWith("/assets")
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const secret = process.env.LOCAL_AUTH_SECRET || "";
  const token = request.cookies.get(COOKIE_NAME)?.value;
  const isAuthenticated = await verifyToken(token, secret);

  if (!isAuthenticated) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`
    );

    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/cron|_next/static|_next/image|favicon.ico).*)"],
};

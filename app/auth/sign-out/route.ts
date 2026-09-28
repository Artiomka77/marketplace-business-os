import { NextResponse } from "next/server";

import { LOCAL_AUTH_COOKIE_NAME } from "@/lib/auth/localAuth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const response = NextResponse.redirect(new URL("/login", url.origin));

  response.cookies.set({
    name: LOCAL_AUTH_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return response;
}

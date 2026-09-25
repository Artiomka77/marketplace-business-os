import { NextResponse } from "next/server";

import {
  createLocalAuthToken,
  getSafeNextPath,
  LOCAL_AUTH_COOKIE_NAME,
  LOCAL_AUTH_MAX_AGE_SECONDS,
  validateLocalAuthCredentials,
} from "@/lib/auth/localAuth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: {
    email?: string;
    password?: string;
    next?: string;
  } = {};

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const email = String(body.email || "");
  const password = String(body.password || "");
  const next = getSafeNextPath(body.next);

  if (!validateLocalAuthCredentials(email, password)) {
    return NextResponse.json(
      {
        ok: false,
        message: "\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 email \u0438\u043b\u0438 \u043f\u0430\u0440\u043e\u043b\u044c.",
      },
      { status: 401 }
    );
  }

  const response = NextResponse.json({
    ok: true,
    next,
  });

  response.cookies.set({
    name: LOCAL_AUTH_COOKIE_NAME,
    value: createLocalAuthToken(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: LOCAL_AUTH_MAX_AGE_SECONDS,
  });

  return response;
}

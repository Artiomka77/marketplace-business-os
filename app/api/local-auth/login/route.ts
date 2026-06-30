import { NextResponse } from "next/server";

import {
  createLocalAuthToken,
  getSafeNextPath,
  isLocalAuthConfigured,
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

  if (!isLocalAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Р’РЅСѓС‚СЂРµРЅРЅСЏСЏ Р°РІС‚РѕСЂРёР·Р°С†РёСЏ РЅРµ РЅР°СЃС‚СЂРѕРµРЅР°. Р—Р°РґР°Р№ LOCAL_AUTH_EMAIL, LOCAL_AUTH_PASSWORD Рё LOCAL_AUTH_SECRET.",
      },
      { status: 500 }
    );
  }

  if (!validateLocalAuthCredentials(email, password)) {
    return NextResponse.json(
      {
        ok: false,
        message: "РќРµРІРµСЂРЅС‹Р№ email РёР»Рё РїР°СЂРѕР»СЊ.",
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
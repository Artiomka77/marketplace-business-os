import { NextRequest, NextResponse } from "next/server";

import { syncWbProductCards } from "@/lib/wb/syncWbProductCards";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function redirectToSettings(
  request: NextRequest,
  status: "success" | "error",
  params: Record<string, string>
) {
  const url = new URL("/settings/api-connections", request.url);

  url.search = new URLSearchParams({
    wbCardsSync: status,
    ...params,
  }).toString();

  return NextResponse.redirect(url);
}

export async function POST(request: NextRequest) {
  let companyId: string | null = null;
  let shouldRedirect = false;

  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();

      companyId = String(formData.get("companyId") ?? "").trim() || null;
      shouldRedirect = true;
    } else {
      const url = new URL(request.url);
      companyId = url.searchParams.get("companyId");

      if (!companyId) {
        const json = await request.json().catch(() => null);
        companyId = typeof json?.companyId === "string" ? json.companyId : null;
      }
    }

    if (!companyId) {
      if (shouldRedirect) {
        return redirectToSettings(request, "error", {
          message: "companyId не передан",
        });
      }

      return NextResponse.json(
        {
          ok: false,
          error: "companyId не передан",
        },
        { status: 400 }
      );
    }

    const result = await syncWbProductCards(companyId);

    if (shouldRedirect) {
      return redirectToSettings(request, "success", {
        rows: String(result.rows),
        pages: String(result.pages),
      });
    }

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    const message = getErrorMessage(error);

    if (shouldRedirect) {
      return redirectToSettings(request, "error", {
        message: message.slice(0, 500),
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 }
    );
  }
}

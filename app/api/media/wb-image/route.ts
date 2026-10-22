import { NextRequest, NextResponse } from "next/server";

const ALLOWED_HOST =
  /^basket-\d+\.wbbasket\.ru$/i;

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("u") || "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("Bad url", { status: 400 });
  }

  if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
    return new NextResponse("Host not allowed", { status: 400 });
  }

  if (!/\/images\//i.test(target.pathname)) {
    return new NextResponse("Path not allowed", { status: 400 });
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://www.wildberries.ru/",
      },
      cache: "force-cache",
      next: { revalidate: 86400 },
    });

    if (!upstream.ok) {
      return new NextResponse("Upstream error", { status: upstream.status });
    }

    const contentType = upstream.headers.get("content-type") || "image/webp";
    if (!contentType.startsWith("image/")) {
      return new NextResponse("Not an image", { status: 502 });
    }

    const bytes = await upstream.arrayBuffer();
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return new NextResponse("Fetch failed", { status: 502 });
  }
}

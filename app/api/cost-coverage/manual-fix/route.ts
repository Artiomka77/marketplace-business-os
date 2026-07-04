import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

function cleanText(value: FormDataEntryValue | null) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanMoney(value: FormDataEntryValue | null) {
  const text = cleanText(value).replace(/\s/g, "").replace(",", ".");
  if (!text) return null;

  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) return null;

  return text;
}

function safeRedirect(value: FormDataEntryValue | null) {
  const text = cleanText(value);
  if (!text || !text.startsWith("/") || text.startsWith("//")) return "/";
  return text;
}

function appendCostFixStatus(redirectTo: string, status: string) {
  const separator = redirectTo.includes("?") ? "&" : "?";
  return `${redirectTo}${separator}costFix=${encodeURIComponent(status)}`;
}

function getSafeRedirectUrl(request: NextRequest, path: string) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const rawHost = forwardedHost || request.headers.get("host") || "ardelo.su";
  const host = rawHost.replace(/^0\.0\.0\.0(?=:|$)/, "localhost");
  const proto =
    forwardedProto ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");

  return new URL(path, `${proto}://${host}`);
}

function redirectBack(request: NextRequest, redirectTo: string, status: string) {
  return NextResponse.redirect(
    getSafeRedirectUrl(request, appendCostFixStatus(redirectTo, status)),
    { status: 303 }
  );
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const redirectTo = safeRedirect(formData.get("redirectTo"));
  const marketplace = cleanText(formData.get("marketplace")).toUpperCase();
  const companyName = cleanText(formData.get("companyName"));
  const externalId = cleanText(formData.get("externalId"));
  const currentVendorCode = cleanText(formData.get("currentVendorCode"));
  const productName = cleanText(formData.get("productName"));
  const sellerVendorCode = cleanText(formData.get("sellerVendorCode"));
  const costPrice = cleanMoney(formData.get("costPrice"));

  if (!companyName || !externalId) {
    return redirectBack(request, redirectTo, "missing-data");
  }

  if (marketplace === "OZON" && sellerVendorCode) {
    const existingMapping = await prisma.ozonProduct.findFirst({
      where: {
        companyName,
        sku: externalId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (existingMapping) {
      await prisma.ozonProduct.update({
        where: {
          id: existingMapping.id,
        },
        data: {
          vendorCode: sellerVendorCode,
          productName: existingMapping.productName || productName || sellerVendorCode,
        },
      });
    } else {
      await prisma.ozonProduct.create({
        data: {
          companyName,
          sku: externalId,
          vendorCode: sellerVendorCode,
          productName: productName || sellerVendorCode,
        },
      });
    }
  }

  if (costPrice) {
    const costVendorCode = sellerVendorCode || currentVendorCode || externalId;

    await prisma.productCost.create({
      data: {
        vendorCode: costVendorCode,
        nmId: externalId,
        name: productName || costVendorCode,
        costPrice,
        costDate: new Date(),
      },
    });
  }

  return redirectBack(request, redirectTo, "ok");
}

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
    return NextResponse.redirect(new URL(`${redirectTo}&costFix=missing-data`, request.url), { status: 303 });
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

  return NextResponse.redirect(new URL(`${redirectTo}&costFix=ok`, request.url), { status: 303 });
}

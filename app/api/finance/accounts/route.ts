import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  const formData = await req.formData();

  const companyName = String(formData.get("companyName") ?? "ИП Петров");
  const name = String(formData.get("name") ?? "").trim();
  const accountType = String(formData.get("accountType") ?? "Банковская карта");
  const openingBalance = Number(
    String(formData.get("openingBalance") ?? "0").replace(",", ".")
  );

  if (!name) {
    return NextResponse.json({ error: "Название счёта обязательно" }, { status: 400 });
  }

  await prisma.financeAccount.create({
    data: {
      companyName,
      name,
      accountType,
      openingBalance: Number.isFinite(openingBalance) ? openingBalance : 0,
      currentBalance: Number.isFinite(openingBalance) ? openingBalance : 0,
    },
  });

  return NextResponse.redirect(new URL("/finance/accounts", req.url));
}
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function toNumber(value: FormDataEntryValue | null) {
  const number = Number(
    String(value ?? "")
      .replace(/\s/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(number) ? number : 0;
}

function toInt(value: FormDataEntryValue | null) {
  const number = Number(String(value ?? "").trim());
  return Number.isInteger(number) ? number : 0;
}

export async function POST(req: Request) {
  const formData = await req.formData();

  const action = String(formData.get("action") ?? "CREATE");
  const id = String(formData.get("id") ?? "").trim();

  const companyName = String(formData.get("companyName") ?? "").trim();
  const periodYear = toInt(formData.get("periodYear"));
  const periodMonth = toInt(formData.get("periodMonth"));

  const data = {
    companyName,
    periodYear,
    periodMonth,
    revenuePlan: toNumber(formData.get("revenuePlan")),
    profitPlan: toNumber(formData.get("profitPlan")),
    adsPlan: toNumber(formData.get("adsPlan")),
    logisticsPlan: toNumber(formData.get("logisticsPlan")),
    taxPlan: toNumber(formData.get("taxPlan")),
    salaryPlan: toNumber(formData.get("salaryPlan")),
    otherPlan: toNumber(formData.get("otherPlan")),
  };

  if (action === "DELETE") {
    if (!id) {
      return NextResponse.json({ error: "ID обязателен" }, { status: 400 });
    }

    await prisma.budgetPlan.delete({
      where: { id },
    });

    return NextResponse.redirect(new URL("/finance/budget", req.url));
  }

  if (!companyName || !periodYear || !periodMonth) {
    return NextResponse.json(
      { error: "Компания, год и месяц обязательны" },
      { status: 400 }
    );
  }

  if (action === "UPDATE") {
    if (!id) {
      return NextResponse.json({ error: "ID обязателен" }, { status: 400 });
    }

    await prisma.budgetPlan.update({
      where: { id },
      data,
    });

    return NextResponse.redirect(new URL("/finance/budget", req.url));
  }

  await prisma.budgetPlan.upsert({
    where: {
      companyName_periodYear_periodMonth: {
        companyName,
        periodYear,
        periodMonth,
      },
    },
    update: data,
    create: data,
  });

  return NextResponse.redirect(new URL("/finance/budget", req.url));
}
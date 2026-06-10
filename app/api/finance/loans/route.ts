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

function toDate(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();

  if (!text) return null;

  const date = new Date(`${text}T12:00:00.000Z`);

  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeFrequency(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();

  if (
    text === "MONTHLY" ||
    text === "WEEKLY" ||
    text === "BIWEEKLY" ||
    text === "TWICE_MONTHLY_15_25" ||
    text === "CUSTOM"
  ) {
    return text;
  }

  return "MONTHLY";
}

export async function POST(req: Request) {
  const formData = await req.formData();

  const companyName = String(formData.get("companyName") ?? "").trim();
  const bankName = String(formData.get("bankName") ?? "").trim();
  const contractNumber = String(formData.get("contractNumber") ?? "").trim();

  const creditLimit = toNumber(formData.get("creditLimit"));
  const currentDebt = toNumber(formData.get("currentDebt"));
  const monthlyPayment = toNumber(formData.get("monthlyPayment"));
  const interestRate = toNumber(formData.get("interestRate"));
  const paymentFrequency = normalizeFrequency(formData.get("paymentFrequency"));

  const startDate = toDate(formData.get("startDate"));
  const endDate = toDate(formData.get("endDate"));

  if (!companyName || !bankName) {
    return NextResponse.json(
      { error: "Компания и банк обязательны" },
      { status: 400 }
    );
  }

  await prisma.loan.create({
    data: {
      companyName,
      bankName,
      contractNumber: contractNumber || null,
      creditLimit: creditLimit || null,
      currentDebt: currentDebt || null,
      monthlyPayment: monthlyPayment || null,
      interestRate: interestRate || null,
      paymentFrequency,
      startDate,
      endDate,
    },
  });

  return NextResponse.redirect(new URL("/finance/loans", req.url));
}